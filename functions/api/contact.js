/*
 * /api/contact：お問い合わせフォームの送信先（Cloudflare Pages Function）
 * 中身の処理は Worker「nanakopiano-contact」（contact-worker/）が行う。ここはサービスバインディング CONTACT で渡すだけ。
 * Worker に届かなかったとき（設定漏れ・障害）は、お客さまに「送信できなかった」と返し、電話・メールを案内する。
 */

const PHONE = "050-1382-1090";
const MAIL = "piano.kyoshitsu.75@gmail.com";

export async function onRequestPost({ request, env }) {
	/* ログは固定の文字だけ（例外の本文はお客さまの入力が混ざる可能性があるので出さない） */
	if (!env.CONTACT) {
		console.error("api/contact", "NO_BINDING");
		return unavailable(request);
	}
	try {
		return await env.CONTACT.fetch(request);
	} catch (e) {
		console.error("api/contact", "WORKER_EXCEPTION");
		return unavailable(request);
	}
}

export function onRequest() {
	return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

function unavailable(request) {
	const ct = (request.headers.get("Content-Type") || "").toLowerCase();
	const accept = (request.headers.get("Accept") || "").toLowerCase();
	if (ct.includes("application/json") || accept.includes("application/json")) {
		return new Response(JSON.stringify({ success: "false", message: "送信できませんでした。" }), {
			status: 503,
			headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
		});
	}
	const html =
		'<!doctype html><html lang="ja"><head><meta charset="utf-8" />' +
		'<meta name="viewport" content="width=device-width, initial-scale=1" />' +
		'<meta name="robots" content="noindex" /><title>送信できませんでした｜石原菜々子 ピアノ教室</title>' +
		"<style>body{font-family:sans-serif;line-height:1.8;margin:0;padding:32px 16px;color:#333;background:#fbf8f4}" +
		"main{max-width:560px;margin:0 auto}a{color:#8a5a44}</style></head><body><main>" +
		"<h1>送信できませんでした。</h1>" +
		'<p>お手数ですが、<a href="tel:' + PHONE.replace(/-/g, "") + '">お電話（' + PHONE + "）</a>または" +
		'<a href="mailto:' + MAIL + '">メール（' + MAIL + "）</a>でご連絡ください。</p>" +
		'<p><a href="https://nanakopiano.com/#contact">お問い合わせのページへ戻る</a></p>' +
		"</main></body></html>";
	return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
