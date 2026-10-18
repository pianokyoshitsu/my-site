/*
 * /api/contact-health：お問い合わせの受け口の健康確認（Cloudflare Pages Function）
 * 受け口（Worker nanakopiano-contact）に件数と時刻だけを聞いて、そのまま返す。個人情報は含まない。
 * 毎朝の見回り（mail-reply-check ルーチン）がここを見て、ok が false なら知らせる。
 */

export async function onRequestGet({ env }) {
	if (!env.CONTACT) {
		console.error("api/contact-health", "NO_BINDING");
		return reply(503, { ok: false, error: "NO_BINDING" });
	}
	try {
		return await env.CONTACT.fetch(new Request("https://nanakopiano-contact.internal/health", { method: "GET" }));
	} catch (e) {
		console.error("api/contact-health", "WORKER_EXCEPTION");
		return reply(503, { ok: false, error: "WORKER_UNREACHABLE" });
	}
}

export function onRequest() {
	return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
}

function reply(status, body) {
	return new Response(JSON.stringify({ ...body, checked_at: new Date().toISOString() }), {
		status: status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}
