/*
 * 石原菜々子 ピアノ教室：お問い合わせフォームの受け口（Cloudflare Worker）
 *
 * サイトの /api/contact（Pages Function）からサービスバインディング経由で呼ばれる。
 * 流れ：受け取る → 控えを保存（D1）→ 教室のGmailへメールで送る（Email Routing）→ 結果を返す
 *
 * いちばん大事なこと＝お問い合わせを取りこぼさない。
 *  - 入力は一文字も削らずに保存・送信する（大きすぎる送信だけは、切らずに「送れなかった」と返す）
 *  - 控えはメールより先に保存する。メールが送れなかった控えは定期処理が自動で送り直す
 *    （最初の24時間は10分おき、その後30日間は1時間おき。メールの障害が長引いても、直れば届く）
 *  - 送り直しは「担当札（lock_token）」を先に付けてから行う＝同じ控えを2つの処理が同時に送らない・
 *    送信済みの記録を後から失敗で上書きしない・回数は送る前に数える（記録の更新に失敗しても無限に送らない）
 *  - メールが送れなかったときは、お客さまに「送信できなかった」と正直に返す（画面に電話・メールの案内が出る）
 *  - 入力の決まりは最小限。迷惑送信らしきもの（隠し欄に入力あり）も捨てず、件名に印を付けて届ける
 *  - ログには受付番号・段階・エラーの種類だけを出す（入力内容やメールアドレスは出さない）
 *
 * 見張り：https://nanakopiano.com/api/contact-health が {"ok":true,...} を返すか（毎朝 mail-reply-check ルーチンが見る）。
 *   ok=false の内訳：unsent_over_30min（30分以上、送れていない・または送れたかを記録できていない）／gave_up（送り直しを打ち切った）／
 *   rescue_stale（定期処理が30分以上、最後まで正常に終わっていない）
 * 控えの確認と対応（Cloudflare の D1「nanakopiano-contact」のコンソールで）：
 *   見る：SELECT id, received_at, mail_status, mail_attempts, rescue_rounds, mail_error FROM submissions WHERE mail_status <> 'sent';
 *   原因を直したあと、その1件だけ送り直す：UPDATE submissions SET mail_status = 'failed', rescue_rounds = 0, lock_token = NULL, lock_until = NULL WHERE id = <番号>;
 *   手で対応済みにする（教室に別の方法で伝えた等）：UPDATE submissions SET mail_status = 'resolved', lock_token = NULL, lock_until = NULL WHERE id = <番号>;
 */

const TO = "piano.kyoshitsu.75@gmail.com";
const FROM = { email: "form@nanakopiano.com", name: "石原菜々子 ピアノ教室 ホームページ" };
const DONE_URL = "https://nanakopiano.com/?sent=1#contact-sent";
const PHONE = "050-1382-1090";

/* メールに載せる順番（フォームの項目名そのまま）。ここに無い項目も、送られてきたら後ろに付けて届ける */
const KNOWN_FIELDS = [
	"お名前",
	"年齢（レッスンを受ける方）",
	"性別",
	"ご連絡先（電話番号またはメールアドレス）",
	"ご連絡のつきやすい時間帯",
	"ご質問・ご要望など",
	"きっかけ",
];
const NAME_FIELD = "お名前";
const CONTACT_FIELD = "ご連絡先（電話番号またはメールアドレス）";
const HONEYPOT = "_honey";

/* 受け付ける送信の大きさ。日本語は送信時に最大9倍ほどに膨らむので、長文でも十分入る大きさにしてある */
const MAX_BODY_BYTES = 512 * 1024;

/* 時間の上限。ブラウザ側は15秒で「結果を確認できなかった」と表示するので、その前に必ず返事をする */
const TIMING = {
	deadlineMs: 11000, /* 1件の処理全体（読み取り〜最後の記録まで） */
	d1Ms: 2000, /* 控えの保存・更新1回 */
	sendMs: 5000, /* メール送信1回 */
	backoffMs: 600, /* 送り直しの間隔（回数×この値） */
	lockMs: 90000, /* 担当札の有効期限（この間はほかの処理が触らない）。⚠️必ず deadlineMs より十分長くすること */
};
const SEND_ATTEMPTS = 3;

/* 定期処理 */
const RESCUE_CRON = "*/10 * * * *"; /* 送れなかった控えを送り直す */
const CLEANUP_CRON = "0 0 1 * *"; /* 古い控えを消す（毎月1日 9:00 日本時間） */
const RESCUE_AFTER_MS = 5 * 60 * 1000; /* 受付から5分たっても送れていないものが対象 */
const FAST_ROUNDS = 144; /* 最初の24時間ぶん（10分おき） */
const MAX_ROUNDS = FAST_ROUNDS + 720; /* その後30日間ぶん（1時間おき）。超えたら gave_up として残す（消さない） */
const SLOW_INTERVAL_MS = 55 * 60 * 1000;
const RESCUE_BATCH = 10;
const KEEP_DAYS = 400; /* 送信済みの控えの保存期間（約1年＋余裕） */
const HEALTH_UNSENT_AFTER_MS = 30 * 60 * 1000; /* 健康確認：受付から30分たっても送れていなければ異常 */
const HEALTH_RESCUE_STALE_MS = 30 * 60 * 1000; /* 健康確認：定期処理が30分以上動いていなければ異常 */

/* 送り直しても同じ結果になるエラー（設定・中身の問題） */
const NO_RETRY = new Set([
	"E_VALIDATION_ERROR",
	"E_FIELD_MISSING",
	"E_CONTENT_TOO_LARGE",
	"E_SENDER_NOT_VERIFIED",
	"E_SENDER_DOMAIN_NOT_AVAILABLE",
	"E_RECIPIENT_NOT_ALLOWED",
	"E_RECIPIENT_SUPPRESSED",
	"E_HEADER_NOT_ALLOWED",
	"E_HEADER_USE_API_FIELD",
	"E_HEADER_VALUE_INVALID",
	"E_HEADER_VALUE_TOO_LONG",
	"E_HEADER_NAME_INVALID",
]);
/* 返信先（お客さまのアドレス）が原因かもしれないエラー。返信先を外して送り直す */
const REPLYTO_SUSPECT = new Set(["E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG"]);

export default {
	async fetch(request, env) {
		const t = timing(env);
		const deadline = Date.now() + t.deadlineMs;
		/* 健康確認（/api/contact-health の Pages Function からだけ届く。件数と時刻だけで個人情報は返さない） */
		if (request.method === "GET" && new URL(request.url).pathname === "/health") {
			return health(env, t);
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
		}
		const wantsJson = isJsonRequest(request);

		let raw;
		try {
			raw = await readFields(request, deadline);
		} catch (e) {
			const status = e && e.status ? e.status : 400;
			log("read", null, status === 413 ? "TOO_LARGE" : status === 408 ? "READ_TIMEOUT" : "BAD_REQUEST");
			return failure(
				wantsJson,
				status,
				status === 413 ? "送信内容が大きすぎて受け付けられませんでした。" : status === 408 ? "通信に時間がかかり、送信できませんでした。" : "送信内容を読み取れませんでした。"
			);
		}

		const suspicious = raw[HONEYPOT] != null && String(raw[HONEYPOT]).trim() !== "";
		const fields = cleanFields(raw);
		if (fields.length === 0) {
			return failure(wantsJson, 400, "入力された内容がありませんでした。");
		}

		const receivedAt = new Date();
		const token = newToken();
		/* 最後の記録の時間を残しておく */
		const id = await saveRecord(env, t, receivedAt, fields, suspicious, token, deadline - t.d1Ms);
		const result = await sendMail(env, t, { fields, receivedAt, id, suspicious, resend: false }, deadline - t.d1Ms);
		await finishRecord(env, t, id, token, result, deadline);

		if (!result.ok) {
			log("send", id, "FAILED:" + result.code + " x" + result.attempts);
			return failure(wantsJson, 502, "送信できませんでした。");
		}
		return success(wantsJson, id);
	},

	async scheduled(event, env) {
		const t = timing(env);
		await ensureTable(env);
		if (event && event.cron === CLEANUP_CRON) {
			const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
			await env.DB.prepare("DELETE FROM submissions WHERE mail_status = 'sent' AND received_at < ?").bind(cutoff).run();
			return;
		}
		await rescue(env, t);
	},
};

/* ---------- 受け取り ---------- */

function isJsonRequest(request) {
	const ct = (request.headers.get("Content-Type") || "").toLowerCase();
	const accept = (request.headers.get("Accept") || "").toLowerCase();
	return ct.includes("application/json") || accept.includes("application/json");
}

/* 大きさを数えながら読み、上限を超えた時点・期限を過ぎた時点でやめる（どの形式でも同じ） */
async function readBodyLimited(request, max, deadline) {
	const declared = Number(request.headers.get("Content-Length") || "0");
	if (declared > max) throw { status: 413 };
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const stop = (status) => {
		reader.cancel().catch(() => {}); /* 読み捨ての完了は待たない */
		return { status };
	};
	const chunks = [];
	let total = 0;
	for (;;) {
		let step;
		try {
			step = await withTimeout(reader.read(), deadline - Date.now());
		} catch (e) {
			throw stop(408);
		}
		if (step.done) break;
		total += step.value.byteLength;
		if (total > max) throw stop(413);
		chunks.push(step.value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

async function readFields(request, deadline) {
	const ct = request.headers.get("Content-Type") || "";
	const lower = ct.toLowerCase();
	const bytes = await readBodyLimited(request, MAX_BODY_BYTES, deadline);
	const text = () => new TextDecoder("utf-8").decode(bytes);

	if (lower.includes("application/json")) {
		const obj = JSON.parse(text());
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw { status: 400 };
		return obj;
	}
	const obj = {};
	const add = (k, v) => {
		obj[k] = Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] + "、" + v : v;
	};
	if (lower.includes("application/x-www-form-urlencoded")) {
		for (const [k, v] of new URLSearchParams(text())) add(k, v);
		return obj;
	}
	if (lower.includes("multipart/form-data")) {
		const fd = await new Response(bytes, { headers: { "Content-Type": ct } }).formData();
		for (const [k, v] of fd.entries()) {
			if (typeof v === "string") add(k, v); /* ファイルは受け付けない（このフォームに添付欄は無い） */
		}
		return obj;
	}
	throw { status: 415 };
}

/* 文字の掃除だけをして、項目の順番をそろえる（中身は一文字も削らない・正しさの判定もしない） */
function cleanFields(raw) {
	const out = [];
	const seen = new Set();
	const push = (key, value) => {
		const k = cleanText(String(key), false);
		if (!k || k.startsWith("_")) return;
		const v = cleanText(value == null ? "" : typeof value === "string" ? value : JSON.stringify(value), true);
		if (!v) return;
		out.push([k, v]);
	};
	for (const key of KNOWN_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) {
			push(key, raw[key]);
			seen.add(key);
		}
	}
	for (const key of Object.keys(raw)) {
		if (!seen.has(key)) push(key, raw[key]);
	}
	return out;
}

function cleanText(s, keepNewlines) {
	let t = s.replace(/\r\n?/g, "\n");
	t = keepNewlines ? t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") : t.replace(/[\u0000-\u001F\u007F]/g, " ");
	return t.trim();
}

/* ---------- 控え（D1） ---------- */

/* 毎回「無ければ作る」を実行する（件数が少ないので負担はない）。
   ⚠️列を増やすときは、本番の表に ALTER TABLE を先に当ててからこの定義を変えること（CREATE IF NOT EXISTS は既存の表を変えない） */
async function ensureTable(env) {
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS submissions (" +
			"id INTEGER PRIMARY KEY AUTOINCREMENT," +
			"received_at TEXT NOT NULL," +
			"data TEXT NOT NULL," +
			"suspicious INTEGER NOT NULL DEFAULT 0," +
			"mail_status TEXT NOT NULL DEFAULT 'pending'," + /* pending / sent / failed / gave_up / resolved（手で対応済み） */
			"mail_attempts INTEGER NOT NULL DEFAULT 0," + /* メールAPIを呼んだ合計回数 */
			"rescue_rounds INTEGER NOT NULL DEFAULT 0," + /* 定期処理が送り直しを担当した回数 */
			"lock_token TEXT," +
			"lock_until TEXT," +
			"mail_error TEXT," +
			"message_id TEXT," +
			"last_attempt_at TEXT," +
			"mailed_at TEXT)"
	).run();
	await env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)").run();
}

/* 担当札つきで保存する（この処理が送るまで定期処理は触らない）。保存できなくてもメールは送る。失敗時は null */
async function saveRecord(env, t, receivedAt, fields, suspicious, token, until) {
	const ms = Math.min(t.d1Ms, until - Date.now());
	if (ms <= 0) return null;
	try {
		return await withTimeout(
			(async () => {
				await ensureTable(env);
				const lockUntil = new Date(Date.now() + t.lockMs).toISOString();
				const res = await env.DB.prepare(
					"INSERT INTO submissions (received_at, data, suspicious, lock_token, lock_until) VALUES (?, ?, ?, ?, ?)"
				)
					.bind(receivedAt.toISOString(), JSON.stringify(fields), suspicious ? 1 : 0, token, lockUntil)
					.run();
				return res && res.meta && res.meta.last_row_id != null ? res.meta.last_row_id : null;
			})(),
			ms
		);
	} catch (e) {
		log("save", null, errCode(e));
		return null;
	}
}

/* 結果を記録して担当札を外す。札が自分のもので、まだ pending/failed のときだけ（送信済み・手で対応済みは上書きしない）。
   記録の命令を最後まで実行できたら true */
async function finishRecord(env, t, id, token, result, deadline, giveUp) {
	if (id == null) return true;
	const ms = Math.min(t.d1Ms, deadline - Date.now());
	if (ms <= 0) {
		log("finish", id, "NO_TIME"); /* 札の期限が切れたあと、定期処理が拾う */
		return false;
	}
	const now = new Date().toISOString();
	const ok = result.ok ? 1 : 0;
	try {
		await withTimeout(
			env.DB.prepare(
				"UPDATE submissions SET " +
					"mail_status = CASE WHEN ?1 = 1 THEN 'sent' WHEN ?9 = 1 OR rescue_rounds >= ?2 THEN 'gave_up' ELSE 'failed' END, " +
					"mail_attempts = mail_attempts + ?3, " +
					"mail_error = CASE WHEN ?1 = 1 THEN NULL ELSE ?4 END, " +
					"message_id = COALESCE(?5, message_id), " +
					"mailed_at = CASE WHEN ?1 = 1 THEN ?6 ELSE mailed_at END, " +
					"last_attempt_at = ?6, lock_token = NULL, lock_until = NULL " +
					"WHERE id = ?7 AND lock_token = ?8 AND mail_status IN ('pending', 'failed')"
			)
				.bind(ok, MAX_ROUNDS, result.attempts, result.ok ? null : result.detail, result.messageId || null, now, id, token, giveUp ? 1 : 0)
				.run(),
			ms
		);
		return true;
	} catch (e) {
		log("finish", id, errCode(e));
		return false;
	}
}

/* 送れなかった控えを送り直す（10分おきに呼ばれる） */
async function rescue(env, t) {
	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();

	/* 控えの読み書きで1つでも失敗したら、この回は「正常に終わった」とは記録しない（健康確認で気づけるように） */
	let dbTrouble = false;
	await setMeta(env, "last_rescue_started_at", now);

	/* 上限まで送り直したのに結果を記録できなかった行を gave_up に整理する（札が切れたものだけ・送信済みは触らない） */
	try {
		await env.DB.prepare(
			"UPDATE submissions SET mail_status = 'gave_up', lock_token = NULL, lock_until = NULL " +
				"WHERE mail_status IN ('pending', 'failed') AND rescue_rounds >= ?1 AND (lock_until IS NULL OR lock_until < ?2)"
		)
			.bind(MAX_ROUNDS, now)
			.run();
	} catch (e) {
		dbTrouble = true;
		log("tidy", null, errCode(e));
	}

	const { results } = await env.DB.prepare(
		"SELECT id, received_at, data, suspicious, rescue_rounds FROM submissions " +
			"WHERE mail_status IN ('pending', 'failed') AND received_at < ?1 AND rescue_rounds < ?2 " +
			"AND (lock_until IS NULL OR lock_until < ?3) " +
			"AND (rescue_rounds < ?4 OR last_attempt_at IS NULL OR last_attempt_at < ?5) " +
			"ORDER BY rescue_rounds, id LIMIT ?6"
	)
		.bind(new Date(nowMs - RESCUE_AFTER_MS).toISOString(), MAX_ROUNDS, now, FAST_ROUNDS, new Date(nowMs - SLOW_INTERVAL_MS).toISOString(), RESCUE_BATCH)
		.all();

	for (const row of results || []) {
		/* 担当札を取る。選んだときと同じ回数のままで、いまも送り直してよい条件（受付5分経過・上限未満・間隔）を
		   満たすときだけ取れる＝同時に動いた別の処理が先に送った・記録した行は取らない。回数はここで数える */
		const token = newToken();
		const claimMs = Date.now();
		const claimedAt = new Date(claimMs).toISOString();
		let claimed = false;
		try {
			const res = await withTimeout(
				env.DB.prepare(
					"UPDATE submissions SET lock_token = ?1, lock_until = ?2, rescue_rounds = rescue_rounds + 1, last_attempt_at = ?3 " +
						"WHERE id = ?4 AND rescue_rounds = ?5 AND mail_status IN ('pending', 'failed') " +
						"AND received_at < ?6 AND rescue_rounds < ?7 AND (lock_until IS NULL OR lock_until < ?3) " +
						"AND (rescue_rounds < ?8 OR last_attempt_at IS NULL OR last_attempt_at < ?9)"
				)
					.bind(
						token,
						new Date(claimMs + t.lockMs).toISOString(),
						claimedAt,
						row.id,
						row.rescue_rounds,
						new Date(claimMs - RESCUE_AFTER_MS).toISOString(),
						MAX_ROUNDS,
						FAST_ROUNDS,
						new Date(claimMs - SLOW_INTERVAL_MS).toISOString()
					)
					.run(),
				t.d1Ms
			);
			claimed = !!(res && res.meta && res.meta.changes === 1);
		} catch (e) {
			dbTrouble = true;
			log("claim", row.id, errCode(e));
		}
		if (!claimed) continue;

		const fields = parseFields(row.data);
		if (!fields) {
			/* 控えが壊れていて送れない＝送り直しても同じなので打ち切る（消さずに gave_up で残す）。次の行へ進む */
			log("rescue", row.id, "BAD_DATA");
			if (!(await finishRecord(env, t, row.id, token, { ok: false, attempts: 0, code: "BAD_DATA", detail: "BAD_DATA" }, Date.now() + t.d1Ms, true))) dbTrouble = true;
			continue;
		}
		const deadline = Date.now() + t.deadlineMs;
		const result = await sendMail(
			env,
			t,
			{ fields, receivedAt: new Date(row.received_at), id: row.id, suspicious: !!row.suspicious, resend: true },
			deadline - t.d1Ms
		);
		if (!(await finishRecord(env, t, row.id, token, result, deadline))) dbTrouble = true;
		if (result.ok) console.log("contact", "rescue", row.id, "SENT");
		else log("rescue", row.id, "FAILED:" + result.code); /* メールが送れなかったこと自体は、記録できていれば正常な一巡 */
	}

	if (dbTrouble) {
		log("rescue", null, "ROUND_INCOMPLETE");
		return;
	}
	await setMeta(env, "last_rescue_ok_at", new Date().toISOString());
}

async function setMeta(env, key, value) {
	try {
		await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind(key, value).run();
	} catch (e) {
		log("meta", null, errCode(e));
	}
}

/* 控えの中身が [["項目","値"], ...] の形かを確かめる。違えば null */
function parseFields(data) {
	let v;
	try {
		v = JSON.parse(data);
	} catch (e) {
		return null;
	}
	const ok = Array.isArray(v) && v.length > 0 && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string");
	return ok ? v : null;
}

/* 健康確認：送れていない控え・打ち切った控え・定期処理の最後の実行時刻（件数と時刻だけ） */
async function health(env, t) {
	const nowMs = Date.now();
	try {
		return await withTimeout(
			(async () => {
				await ensureTable(env);
				const unsent = await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM submissions WHERE mail_status IN ('pending', 'failed') AND received_at < ?1"
				)
					.bind(new Date(nowMs - HEALTH_UNSENT_AFTER_MS).toISOString())
					.first();
				const gaveUp = await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE mail_status = 'gave_up'").first();
				const beat = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_rescue_ok_at'").first();
				const lastOkAt = beat && beat.v ? String(beat.v) : null;
				const lastOkMs = lastOkAt ? Date.parse(lastOkAt) : NaN;
				/* 記録なし・日時として読めない・古すぎる・未来すぎる（時計の狂い）は、どれも「止まっている」扱い */
				const rescueStale = !Number.isFinite(lastOkMs) || lastOkMs < nowMs - HEALTH_RESCUE_STALE_MS || lastOkMs > nowMs + 5 * 60 * 1000;
				const unsentN = unsent ? Number(unsent.n) : 0;
				const gaveUpN = gaveUp ? Number(gaveUp.n) : 0;
				return json(200, {
					ok: unsentN === 0 && gaveUpN === 0 && !rescueStale,
					unsent_over_30min: unsentN,
					gave_up: gaveUpN,
					last_rescue_ok_at: lastOkAt,
					rescue_stale: rescueStale,
					checked_at: new Date(nowMs).toISOString(),
				});
			})(),
			t.d1Ms * 2
		);
	} catch (e) {
		log("health", null, errCode(e));
		return json(503, { ok: false, error: "DB_UNAVAILABLE", checked_at: new Date(nowMs).toISOString() });
	}
}

/* ---------- メール ---------- */

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function buildMail(m, withReplyTo) {
	const get = (k) => (m.fields.find(([key]) => key === k) || [])[1] || "";
	const name = cleanText(get(NAME_FIELD), false).slice(0, 40);
	const contact = get(CONTACT_FIELD).trim();
	const replyTo = withReplyTo && contact.length <= 254 && EMAIL_RE.test(contact) ? contact : null;

	const lines = [];
	if (m.resend) {
		lines.push("※このメールは自動の送り直しです。最初の送信が完了したことを控えで確認できなかったため、受付の控えから送り直しました。");
		lines.push("　同じお問い合わせがすでに届いている場合があります。受付番号と内容を見比べてください。");
		lines.push("　（最初の送信が失敗していた場合、お客さまの画面には「送信できませんでした」と出ているので、お電話やメールでも連絡が来ているかもしれません）");
		lines.push("");
	}
	if (m.suspicious) {
		lines.push("※機械的な送信（迷惑送信）の可能性があります（人には見えない欄に入力がありました）。内容をご確認ください。");
		lines.push("");
	}
	lines.push("ホームページのお問い合わせフォームから、新しいお申し込み・お問い合わせが届きました。");
	lines.push("");
	for (const [k, v] of m.fields) {
		lines.push("■ " + k);
		lines.push(v);
		lines.push("");
	}
	lines.push("――――――――――――――――");
	lines.push("受付日時：" + formatJst(m.receivedAt) + "（日本時間）");
	if (m.id != null) lines.push("受付番号：" + m.id);
	if (replyTo) lines.push("このメールに返信すると、ご記入のメールアドレス（" + replyTo + "）に届きます。");
	else if (contact) lines.push("お返事は、ご記入のご連絡先（" + contact.split("\n")[0] + "）へお願いします。");
	lines.push("このメールは nanakopiano.com のフォームから自動で送られています。");

	const prefix = (m.resend ? "【再送】" : "") + (m.suspicious ? "【要確認】" : "");
	const mail = {
		to: TO,
		from: FROM,
		subject: prefix + "【ホームページ】体験レッスンのお申し込み：" + (name || "お名前未記入") + " 様",
		text: lines.join("\n"),
	};
	if (replyTo) mail.replyTo = replyTo;
	return mail;
}

function formatJst(d) {
	const j = new Date(d.getTime() + 9 * 3600000);
	const p = (n) => String(n).padStart(2, "0");
	return j.getUTCFullYear() + "年" + (j.getUTCMonth() + 1) + "月" + j.getUTCDate() + "日 " + p(j.getUTCHours()) + ":" + p(j.getUTCMinutes());
}

/* 期限内で最大3回送る。返信先が原因らしいエラーなら、返信先を外して送り直す */
async function sendMail(env, t, m, deadline) {
	let withReplyTo = true;
	let code = "";
	let detail = "";
	let attempts = 0;
	while (attempts < SEND_ATTEMPTS) {
		const remaining = deadline - Date.now();
		if (remaining < 500) break;
		attempts++;
		let mail;
		try {
			mail = buildMail(m, withReplyTo);
		} catch (e) {
			log("build", m.id, "BUILD_ERROR");
			return { ok: false, attempts: attempts - 1, code: "BUILD_ERROR", detail: "BUILD_ERROR" };
		}
		try {
			const res = await withTimeout(env.EMAIL.send(mail), Math.min(t.sendMs, remaining));
			return { ok: true, attempts, messageId: res && res.messageId ? String(res.messageId) : null };
		} catch (e) {
			code = errCode(e);
			detail = (code + ": " + ((e && e.message) || "")).slice(0, 300);
			log("send-attempt", m.id, code + " #" + attempts);
			if (mail.replyTo && REPLYTO_SUSPECT.has(code)) {
				withReplyTo = false;
				continue;
			}
			if (NO_RETRY.has(code)) break;
			const wait = Math.min(attempts * t.backoffMs, deadline - Date.now() - 500);
			if (wait > 0) await sleep(wait);
		}
	}
	return { ok: false, attempts, code: code || "NO_TIME", detail: detail || "NO_TIME" };
}

/* ---------- 共通 ---------- */

function timing(env) {
	/* テストのときだけ時間を短くできる（本番の設定には無い） */
	return env && env.CONTACT_TEST_TIMING ? { ...TIMING, ...env.CONTACT_TEST_TIMING } : TIMING;
}

function newToken() {
	return crypto.randomUUID();
}

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const e = new Error("timeout");
			e.code = "TIMEOUT";
			reject(e);
		}, Math.max(1, ms));
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function errCode(e) {
	const c = e && e.code ? String(e.code) : "UNKNOWN";
	return /^[A-Z0-9_]{1,40}$/.test(c) ? c : "UNKNOWN";
}

/* ログは受付番号・段階・エラーの種類だけ（入力内容・アドレス・例外の本文は出さない） */
function log(stage, id, code) {
	console.error("contact", stage, id == null ? "-" : id, code);
}

/* ---------- 返事 ---------- */

function success(wantsJson, id) {
	if (wantsJson) return json(200, { success: "true", id: id });
	return new Response(null, { status: 303, headers: { Location: DONE_URL } });
}

function failure(wantsJson, status, message) {
	if (wantsJson) return json(status, { success: "false", message: message });
	return new Response(failurePage(message), {
		status: status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function json(status, body) {
	return new Response(JSON.stringify(body), {
		status: status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function failurePage(message) {
	return (
		'<!doctype html><html lang="ja"><head><meta charset="utf-8" />' +
		'<meta name="viewport" content="width=device-width, initial-scale=1" />' +
		'<meta name="robots" content="noindex" /><title>送信できませんでした｜石原菜々子 ピアノ教室</title>' +
		"<style>body{font-family:sans-serif;line-height:1.8;margin:0;padding:32px 16px;color:#333;background:#fbf8f4}" +
		"main{max-width:560px;margin:0 auto}a{color:#8a5a44}</style></head><body><main>" +
		"<h1>" + escapeHtml(message) + "</h1>" +
		"<p>お手数ですが、<a href=\"tel:" + PHONE.replace(/-/g, "") + "\">お電話（" + PHONE + "）</a>または" +
		"<a href=\"mailto:" + TO + "\">メール（" + TO + "）</a>でご連絡ください。</p>" +
		"<p>ブラウザの「戻る」で前の画面に戻ると、ご入力の内容が残っている場合があります。</p>" +
		"<p><a href=\"https://nanakopiano.com/#contact\">お問い合わせのページへ戻る</a></p>" +
		"</main></body></html>"
	);
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
