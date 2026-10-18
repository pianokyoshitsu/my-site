/*
 * 受け口（src/index.js）の動作テスト。
 * D1 は Node 内蔵の SQLite（本物のSQLとして動く）で代用し、メール送信は手元の偽物に差し替える。
 * 実行：node test/unit.test.js（contact-worker フォルダで）
 * 見ていること＝「本物のお問い合わせが一文字も欠けずに届く」「失敗したら失敗と返す」「控えが残り、自動で送り直される」
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import * as pagesFn from "../../functions/api/contact.js";

const FAST = { deadlineMs: 1500, d1Ms: 200, sendMs: 300, backoffMs: 20, lockMs: 40 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESCUE = { cron: "*/10 * * * *" };
const CLEANUP = { cron: "0 0 1 * *" };

/* ---------- D1 の代わり（SQLite） ---------- */
function makeD1({ failAll = false, hang = false, failFinal = false } = {}) {
	const db = new DatabaseSync(":memory:");
	const never = () => new Promise(() => {});
	return {
		sql: db,
		rows: () => {
			try {
				return db.prepare("SELECT * FROM submissions ORDER BY id").all();
			} catch (e) {
				return [];
			}
		},
		prepare(sql) {
			let args = [];
			const stmt = {
				bind(...a) {
					args = a;
					return stmt;
				},
				async run() {
					if (hang) return never();
					if (failAll) throw new Error("D1 down");
					if (failFinal && sql.startsWith("UPDATE submissions SET mail_status")) throw new Error("final update failed");
					const r = db.prepare(sql).run(...args);
					return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
				},
				async all() {
					if (hang) return never();
					if (failAll) throw new Error("D1 down");
					return { results: db.prepare(sql).all(...args) };
				},
				async first() {
					if (hang) return never();
					if (failAll) throw new Error("D1 down");
					return db.prepare(sql).get(...args) || null;
				},
			};
			return stmt;
		},
	};
}

/* ---------- メール送信の偽物 ---------- */
function makeEmail(plan = []) {
	/* plan：呼ばれるたびの結果。"ok"／エラーコード／"hang"（返事が来ない）。足りない分は "ok" */
	const sent = [];
	const tried = [];
	let calls = 0;
	const delayMs = plan.delayMs || 0;
	return {
		sent,
		tried,
		get calls() {
			return calls;
		},
		async send(mail) {
			tried.push(mail);
			const step = plan[calls++] || "ok";
			if (delayMs) await sleep(delayMs);
			if (step === "hang") return new Promise(() => {});
			if (step !== "ok") {
				const e = new Error("simulated " + step + " for parent@example.com");
				e.code = step;
				throw e;
			}
			sent.push(mail);
			return { messageId: "msg-" + calls };
		},
	};
}

const env = (DB, EMAIL) => ({ DB, EMAIL, CONTACT_TEST_TIMING: FAST });

const SAMPLE = {
	_honey: "",
	"お名前": "テスト 花子",
	"年齢（レッスンを受ける方）": "7歳",
	"性別": "女性",
	"ご連絡先（電話番号またはメールアドレス）": "parent@example.com",
	"ご連絡のつきやすい時間帯": "平日18時以降",
	"ご質問・ご要望など": "発表会について知りたいです。\n送迎の都合で平日夕方が希望です。",
	"きっかけ": "チラシのQRコード（ごあいさつ版）",
};

const URL_ = "https://nanakopiano.com/api/contact";
const jsonReq = (body) =>
	new Request(URL_, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
const formReq = (obj) =>
	new Request(URL_, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(obj).toString() });

/* ログに個人情報が出ていないかを見るため、console.error を記録する */
const logs = [];
const origErr = console.error;
console.error = (...a) => logs.push(a.map(String).join(" "));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- 正常系 ---------- */

test("AJAX送信：200・メール1通・控えは sent（messageId も残る）", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	const res = await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 200);
	assert.equal((await res.json()).success, "true");
	assert.equal(EMAIL.sent.length, 1);
	const [row] = DB.rows();
	assert.equal(row.mail_status, "sent");
	assert.equal(row.mail_attempts, 1);
	assert.equal(row.message_id, "msg-1");
	assert.ok(row.mailed_at);
	const m = EMAIL.sent[0];
	assert.equal(m.to, "piano.kyoshitsu.75@gmail.com");
	assert.equal(m.from.email, "form@nanakopiano.com");
	assert.equal(m.replyTo, "parent@example.com");
	assert.equal(m.subject, "【ホームページ】体験レッスンのお申し込み：テスト 花子 様");
	let pos = -1;
	for (const k of Object.keys(SAMPLE).filter((k) => !k.startsWith("_"))) {
		const p = m.text.indexOf("■ " + k + "\n" + SAMPLE[k]);
		assert.ok(p > pos, "項目と値が順番どおり: " + k);
		pos = p;
	}
	assert.ok(m.text.includes("受付番号：1"));
	assert.ok(!m.text.includes("_honey"));
});

test("JSなしの通常送信：303で完了ページへ", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	const res = await worker.fetch(formReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 303);
	assert.equal(res.headers.get("Location"), "https://nanakopiano.com/?sent=1#contact-sent");
	assert.ok(EMAIL.sent[0].text.includes("■ ご質問・ご要望など\n発表会について知りたいです。\n送迎の都合で平日夕方が希望です。"));
});

test("multipart形式でも届く", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	const fd = new FormData();
	for (const [k, v] of Object.entries(SAMPLE)) fd.append(k, v);
	const res = await worker.fetch(new Request(URL_, { method: "POST", body: fd }), env(DB, EMAIL));
	assert.equal(res.status, 303);
	assert.ok(EMAIL.sent[0].text.includes("テスト 花子"));
});

test("長文（2万字）も一文字も欠けずにメールと控えに入る", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	const long = "あ".repeat(20000) + "【ここが大事な末尾】";
	const res = await worker.fetch(formReq({ ...SAMPLE, "ご質問・ご要望など": long }), env(DB, EMAIL));
	assert.equal(res.status, 303);
	assert.ok(EMAIL.sent[0].text.includes(long));
	assert.ok(JSON.parse(DB.rows()[0].data).some(([k, v]) => v === long));
});

test("項目が多くても捨てない（50項目）", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	const extra = {};
	for (let i = 1; i <= 50; i++) extra["追加" + i] = "値" + i;
	await worker.fetch(jsonReq({ ...SAMPLE, ...extra }), env(DB, EMAIL));
	assert.ok(EMAIL.sent[0].text.includes("■ 追加50\n値50"));
});

test("知らない項目も後ろに付けて届ける", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	await worker.fetch(jsonReq({ ...SAMPLE, "希望の曜日": "土曜" }), env(DB, EMAIL));
	const t = EMAIL.sent[0].text;
	assert.ok(t.indexOf("■ きっかけ") < t.indexOf("■ 希望の曜日\n土曜"));
});

test("連絡先が電話番号：replyTo なし・本文に連絡先の案内", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	await worker.fetch(jsonReq({ ...SAMPLE, "ご連絡先（電話番号またはメールアドレス）": "090-1234-5678" }), env(DB, EMAIL));
	assert.equal(EMAIL.sent[0].replyTo, undefined);
	assert.ok(EMAIL.sent[0].text.includes("お返事は、ご記入のご連絡先（090-1234-5678）へお願いします。"));
});

test("全角の句点が付いたアドレスなど怪しい形は replyTo にしない（本文には残す）", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	await worker.fetch(jsonReq({ ...SAMPLE, "ご連絡先（電話番号またはメールアドレス）": "parent@example.com。" }), env(DB, EMAIL));
	assert.equal(EMAIL.sent[0].replyTo, undefined);
	assert.ok(EMAIL.sent[0].text.includes("parent@example.com。"));
});

test("返信先が原因のエラー：返信先を外して送り直し、届く", async () => {
	const DB = makeD1(), EMAIL = makeEmail(["E_VALIDATION_ERROR", "ok"]);
	const res = await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 200);
	assert.equal(EMAIL.tried[0].replyTo, "parent@example.com");
	assert.equal(EMAIL.sent[0].replyTo, undefined);
	assert.ok(!EMAIL.sent[0].text.includes("このメールに返信すると"));
	assert.ok(EMAIL.sent[0].text.includes("parent@example.com"));
	assert.equal(DB.rows()[0].mail_attempts, 2);
});

/* ---------- 失敗系 ---------- */

test("一時的な失敗（2回）→3回目で届く", async () => {
	const DB = makeD1(), EMAIL = makeEmail(["E_INTERNAL_SERVER_ERROR", "E_DELIVERY_FAILED", "ok"]);
	const res = await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 200);
	assert.equal(DB.rows()[0].mail_attempts, 3);
});

test("最後まで送れない：502・控えは failed で全文が残る・mailed_at は空", async () => {
	const DB = makeD1(), EMAIL = makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"]);
	const res = await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 502);
	assert.equal((await res.json()).success, "false");
	const [row] = DB.rows();
	assert.equal(row.mail_status, "failed");
	assert.equal(row.mailed_at, null);
	assert.ok(row.last_attempt_at);
	assert.ok(JSON.parse(row.data).some(([k, v]) => k === "お名前" && v === "テスト 花子"));
});

test("設定の問題（送り直しても無駄）は1回で止めて失敗を返す", async () => {
	const DB = makeD1(), EMAIL = makeEmail(["E_RECIPIENT_NOT_ALLOWED"]);
	const res = await worker.fetch(jsonReq({ ...SAMPLE, "ご連絡先（電話番号またはメールアドレス）": "090-1" }), env(DB, EMAIL));
	assert.equal(res.status, 502);
	assert.equal(EMAIL.calls, 1);
});

test("メール送信の返事が来ない：期限内に失敗を返す（成功にしない）", async () => {
	const DB = makeD1(), EMAIL = makeEmail(["hang", "hang", "hang"]);
	const t0 = Date.now();
	const res = await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 502);
	assert.ok(Date.now() - t0 < FAST.deadlineMs + 800, "期限内に返事");
	assert.equal(DB.rows()[0].mail_status, "failed");
});

test("D1 の返事が来ない：控えは諦めてメールは届く・期限内に返事", async () => {
	const DB = makeD1({ hang: true }), EMAIL = makeEmail();
	const t0 = Date.now();
	const res = await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 200);
	assert.equal(EMAIL.sent.length, 1);
	assert.ok(Date.now() - t0 < 2000);
});

test("D1 が壊れていてもメールは届く（受付番号は載せない）", async () => {
	const DB = makeD1({ failAll: true }), EMAIL = makeEmail();
	const res = await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.equal(res.status, 200);
	assert.ok(!EMAIL.sent[0].text.includes("受付番号"));
});

test("JSなしでメール失敗：電話・メール案内のページ", async () => {
	const DB = makeD1(), EMAIL = makeEmail(["E_RECIPIENT_NOT_ALLOWED"]);
	const res = await worker.fetch(formReq({ ...SAMPLE, "ご連絡先（電話番号またはメールアドレス）": "090" }), env(DB, EMAIL));
	assert.equal(res.status, 502);
	const html = await res.text();
	assert.ok(html.includes("050-1382-1090") && html.includes("mailto:piano.kyoshitsu.75@gmail.com"));
});

/* ---------- 迷惑送信・不正な入力 ---------- */

test("隠し欄に入力あり：捨てずに【要確認】付きで届け、控えに印", async () => {
	const DB = makeD1(), EMAIL = makeEmail();
	const res = await worker.fetch(jsonReq({ ...SAMPLE, _honey: "x" }), env(DB, EMAIL));
	assert.equal(res.status, 200);
	assert.ok(EMAIL.sent[0].subject.startsWith("【要確認】"));
	assert.ok(EMAIL.sent[0].text.includes("機械的な送信"));
	assert.equal(DB.rows()[0].suspicious, 1);
});

test("中身が空：400", async () => {
	const res = await worker.fetch(jsonReq({ _honey: "", "お名前": "   " }), env(makeD1(), makeEmail()));
	assert.equal(res.status, 400);
});

test("壊れたJSON：400（落ちない）", async () => {
	const res = await worker.fetch(jsonReq("{broken"), env(makeD1(), makeEmail()));
	assert.equal(res.status, 400);
	assert.equal((await res.json()).success, "false");
});

test("大きすぎる送信（Content-Lengthあり）：413", async () => {
	const res = await worker.fetch(jsonReq({ "お名前": "x".repeat(600 * 1024) }), env(makeD1(), makeEmail()));
	assert.equal(res.status, 413);
});

test("大きすぎる送信（Content-Lengthなし・小分け）：読みながら413で止める", async () => {
	let pushed = 0;
	const stream = new ReadableStream({
		pull(c) {
			if (pushed >= 700) return c.close();
			pushed++;
			c.enqueue(new TextEncoder().encode("a".repeat(1024)));
		},
	});
	const req = new Request(URL_, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: stream, duplex: "half" });
	const res = await worker.fetch(req, env(makeD1(), makeEmail()));
	assert.equal(res.status, 413);
	assert.ok(pushed < 700, "途中で読むのをやめた");
});

test("知らない形式：415", async () => {
	const res = await worker.fetch(new Request(URL_, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" }), env(makeD1(), makeEmail()));
	assert.equal(res.status, 415);
});

test("POST以外：405", async () => {
	const res = await worker.fetch(new Request(URL_), env(makeD1(), makeEmail()));
	assert.equal(res.status, 405);
});

test("件名に改行を入れられない・名前未記入でも崩れない", async () => {
	const EMAIL = makeEmail();
	await worker.fetch(jsonReq({ ...SAMPLE, "お名前": "山田\r\nBcc: evil@example.com" }), env(makeD1(), EMAIL));
	assert.ok(!/[\r\n]/.test(EMAIL.sent[0].subject));
	const EMAIL2 = makeEmail();
	await worker.fetch(jsonReq({ ...SAMPLE, "お名前": "" }), env(makeD1(), EMAIL2));
	assert.equal(EMAIL2.sent[0].subject, "【ホームページ】体験レッスンのお申し込み：お名前未記入 様");
});

test("連絡先にヘッダー注入ねらいの改行：replyTo にしない", async () => {
	const EMAIL = makeEmail();
	await worker.fetch(jsonReq({ ...SAMPLE, "ご連絡先（電話番号またはメールアドレス）": "a@b.com\nBcc: x@y.com" }), env(makeD1(), EMAIL));
	assert.equal(EMAIL.sent[0].replyTo, undefined);
});

/* ---------- 定期処理（送り直し・掃除） ---------- */

test("送り直し：失敗した控えを【再送】で届け、sent にする", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	assert.equal(DB.rows()[0].mail_status, "failed");
	/* 5分以上たったことにする */
	DB.sql.prepare("UPDATE submissions SET received_at = ?").run(new Date(Date.now() - 10 * 60000).toISOString());
	const EMAIL = makeEmail();
	await worker.scheduled(RESCUE, env(DB, EMAIL));
	assert.equal(EMAIL.sent.length, 1);
	assert.ok(EMAIL.sent[0].subject.startsWith("【再送】"));
	assert.ok(EMAIL.sent[0].text.includes("自動の送り直し"));
	assert.ok(EMAIL.sent[0].text.includes("テスト 花子"));
	const [row] = DB.rows();
	assert.equal(row.mail_status, "sent");
	assert.equal(row.mail_attempts, 4);
});

test("送り直し：受付から5分未満のものはまだ触らない", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	const EMAIL = makeEmail();
	await worker.scheduled(RESCUE, env(DB, EMAIL));
	assert.equal(EMAIL.calls, 0);
});

test("送り直し：途中で止まった pending も拾う", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail()));
	DB.sql.prepare("UPDATE submissions SET mail_status = 'pending', mail_attempts = 0, received_at = ?").run(new Date(Date.now() - 10 * 60000).toISOString());
	const EMAIL = makeEmail();
	await worker.scheduled(RESCUE, env(DB, EMAIL));
	assert.equal(EMAIL.sent.length, 1);
	assert.equal(DB.rows()[0].mail_status, "sent");
});

test("送り直し：上限回数を超えたら gave_up で残す（消さない）", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	DB.sql.prepare("UPDATE submissions SET rescue_rounds = 863, last_attempt_at = ?, received_at = ?").run(new Date(Date.now() - 2 * 3600000).toISOString(), new Date(Date.now() - 31 * 86400000).toISOString());
	await worker.scheduled(RESCUE, env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	assert.equal(DB.rows()[0].mail_status, "gave_up");
	const EMAIL = makeEmail();
	await worker.scheduled(RESCUE, env(DB, EMAIL));
	assert.equal(EMAIL.calls, 0, "gave_up はもう送らない");
	assert.equal(DB.rows().length, 1);
});

test("掃除：古い送信済みだけ消し、未送信は古くても残す", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail()));
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail(["E_RECIPIENT_NOT_ALLOWED"])));
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail()));
	const old = new Date(Date.now() - 500 * 86400000).toISOString();
	DB.sql.prepare("UPDATE submissions SET received_at = ? WHERE id IN (1, 2)").run(old);
	await worker.scheduled(CLEANUP, env(DB, makeEmail()));
	const ids = DB.rows().map((r) => r.id);
	assert.deepEqual(ids, [2, 3]);
});

test("送り直し：最後の記録が失敗し続けても、回数は増え・後ろの控えも順番に拾う（無限に同じものを送らない）", async () => {
	const DB = makeD1({ failFinal: true });
	const fail3 = () => makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"]);
	for (let i = 0; i < 11; i++) await worker.fetch(jsonReq({ ...SAMPLE, "お名前": "客" + i }), env(DB, fail3()));
	DB.sql.prepare("UPDATE submissions SET mail_status = 'failed', lock_token = NULL, lock_until = NULL, received_at = ?").run(new Date(Date.now() - 10 * 60000).toISOString());
	const EMAIL = makeEmail();
	await worker.scheduled(RESCUE, env(DB, EMAIL));
	assert.equal(EMAIL.sent.length, 10, "1回目は10件");
	await sleep(60); /* 担当札の期限切れを待つ */
	await worker.scheduled(RESCUE, env(DB, EMAIL));
	const names = EMAIL.sent.map((m) => m.subject);
	assert.ok(names.some((s) => s.includes("客10")), "11件目も2回目で拾われる");
	const rounds = DB.rows().map((r) => r.rescue_rounds);
	assert.ok(rounds.every((n) => n >= 1), "全件の回数が増えている: " + rounds);
	assert.equal(EMAIL.sent.length, rounds.reduce((a, b) => a + b, 0), "送った数＝数えた回数");
});

test("送り直し：2つの定期処理が同時に動いても、1件につき1回しか送らない", async () => {
	const DB = makeD1();
	for (let i = 0; i < 4; i++) await worker.fetch(jsonReq({ ...SAMPLE, "お名前": "同時" + i }), env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	DB.sql.prepare("UPDATE submissions SET received_at = ?").run(new Date(Date.now() - 10 * 60000).toISOString());
	const plan = [];
	plan.delayMs = 30;
	const EMAIL = makeEmail(plan);
	/* 本番と同じく「担当札の期限 > 1件の処理時間」にする */
	const e2 = { DB, EMAIL, CONTACT_TEST_TIMING: { ...FAST, lockMs: 5000 } };
	await Promise.all([worker.scheduled(RESCUE, e2), worker.scheduled(RESCUE, e2)]);
	assert.equal(EMAIL.sent.length, 4);
	assert.ok(DB.rows().every((r) => r.mail_status === "sent" && r.rescue_rounds === 1));
});

test("送り直し：遅れて失敗が返っても、送信済みの記録は上書きしない", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	DB.sql.prepare("UPDATE submissions SET received_at = ?").run(new Date(Date.now() - 10 * 60000).toISOString());
	const plan = ["E_RECIPIENT_NOT_ALLOWED"];
	plan.delayMs = 60;
	const run = worker.scheduled(RESCUE, env(DB, makeEmail(plan)));
	await sleep(20);
	/* 送信中に、別の経路で送信済みになったことにする */
	DB.sql.prepare("UPDATE submissions SET mail_status = 'sent', message_id = 'keep-me', mailed_at = 'x'").run();
	await run;
	const [row] = DB.rows();
	assert.equal(row.mail_status, "sent");
	assert.equal(row.message_id, "keep-me");
	assert.equal(row.mailed_at, "x");
});

test("送り直し：24時間を過ぎたものは1時間おきにだけ送る", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	DB.sql
		.prepare("UPDATE submissions SET rescue_rounds = 144, last_attempt_at = ?, received_at = ?")
		.run(new Date(Date.now() - 10 * 60000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString());
	const E1 = makeEmail();
	await worker.scheduled(RESCUE, env(DB, E1));
	assert.equal(E1.calls, 0, "前回から10分では送らない");
	DB.sql.prepare("UPDATE submissions SET last_attempt_at = ?").run(new Date(Date.now() - 60 * 60000).toISOString());
	const E2 = makeEmail();
	await worker.scheduled(RESCUE, env(DB, E2));
	assert.equal(E2.sent.length, 1, "前回から1時間たったら送る");
});

test("送り直し：控えが壊れていたら gave_up で残して打ち切る", async () => {
	const DB = makeD1();
	await worker.fetch(jsonReq(SAMPLE), env(DB, makeEmail(["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR"])));
	DB.sql.prepare("UPDATE submissions SET data = '{broken', received_at = ?").run(new Date(Date.now() - 10 * 60000).toISOString());
	await worker.scheduled(RESCUE, env(DB, makeEmail()));
	assert.equal(DB.rows()[0].mail_status, "gave_up");
});

test("送信内容が途中で止まる：期限内に408で返す", async () => {
	const stream = new ReadableStream({
		pull() {
			return new Promise(() => {});
		},
	});
	const req = new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: stream, duplex: "half" });
	const t0 = Date.now();
	const res = await worker.fetch(req, { DB: makeD1(), EMAIL: makeEmail(), CONTACT_TEST_TIMING: { ...FAST, deadlineMs: 300 } });
	assert.equal(res.status, 408);
	assert.ok(Date.now() - t0 < 1000);
});

test("全体の時間：メールが遅くても、最後の記録まで含めて期限内に返す", async () => {
	const DB = makeD1(), EMAIL = makeEmail(["hang", "hang", "hang"]);
	const t0 = Date.now();
	await worker.fetch(jsonReq(SAMPLE), env(DB, EMAIL));
	assert.ok(Date.now() - t0 <= FAST.deadlineMs + 150, "所要 " + (Date.now() - t0) + "ms");
	assert.equal(DB.rows()[0].mail_status, "failed", "最後の記録も書けている");
});

/* ---------- Pages Function（/api/contact の中継） ---------- */

test("中継：受け口の返事をそのまま返す", async () => {
	const res = await pagesFn.onRequestPost({ request: jsonReq(SAMPLE), env: { CONTACT: { fetch: async () => new Response("ok", { status: 200 }) } } });
	assert.equal(res.status, 200);
});

test("中継：受け口の設定が無い／例外 → 503（JSONなら JSON、通常POSTなら案内ページ）・ログに個人情報なし", async () => {
	const before = logs.length;
	const r1 = await pagesFn.onRequestPost({ request: jsonReq(SAMPLE), env: {} });
	assert.equal(r1.status, 503);
	assert.equal((await r1.json()).success, "false");
	const r2 = await pagesFn.onRequestPost({
		request: formReq(SAMPLE),
		env: {
			CONTACT: {
				fetch: async () => {
					throw new Error("boom parent@example.com テスト 花子");
				},
			},
		},
	});
	assert.equal(r2.status, 503);
	assert.ok((await r2.text()).includes("050-1382-1090"));
	const newLogs = logs.slice(before).join("\n");
	assert.ok(newLogs.includes("NO_BINDING") && newLogs.includes("WORKER_EXCEPTION"));
	assert.ok(!newLogs.includes("parent@example.com") && !newLogs.includes("花子"));
});

test("中継：POST以外は405", async () => {
	assert.equal(pagesFn.onRequest().status, 405);
});

test("ログにお客さまのアドレスや入力内容が出ていない", async () => {
	const joined = logs.join("\n");
	assert.ok(!joined.includes("parent@example.com"), "アドレスが出ていない");
	assert.ok(!joined.includes("テスト 花子"), "名前が出ていない");
	assert.ok(logs.length > 0, "ログ自体は出ている");
});

/* ---------- 実行 ---------- */
let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		process.stdout.write("OK   " + name + "\n");
	} catch (e) {
		failed++;
		process.stdout.write("FAIL " + name + "\n     " + (e && e.message) + "\n");
	}
}
console.error = origErr;
process.stdout.write("\n" + (tests.length - failed) + "/" + tests.length + " passed\n");
process.exit(failed ? 1 : 0);
