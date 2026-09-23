/* 石原菜々子 ピアノ教室 — Piano Atelier Edition */
(function () {
	"use strict";

	/* ヘッダー：スクロールで背景を付ける */
	var header = document.getElementById("siteHeader");
	var onScroll = function () {
		header.classList.toggle("scrolled", window.scrollY > 24);
	};
	window.addEventListener("scroll", onScroll, { passive: true });
	onScroll();

	/* スクロールリビール */
	var reveals = document.querySelectorAll(".reveal");
	if ("IntersectionObserver" in window) {
		var io = new IntersectionObserver(function (entries) {
			entries.forEach(function (e) {
				if (e.isIntersecting) {
					e.target.classList.add("in");
					io.unobserve(e.target);
				}
			});
		}, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
		reveals.forEach(function (el) { io.observe(el); });
	} else {
		reveals.forEach(function (el) { el.classList.add("in"); });
	}

	/* Aboutスライドショー（クロスフェード＋ドット） */
	var show = document.getElementById("slideshow");
	if (show) {
		var slides = show.querySelectorAll(".slide");
		var dotsBox = show.querySelector(".slide-dots");
		var current = 0;
		var timer = null;

		var go = function (i) {
			slides[current].classList.remove("active");
			dotsBox.children[current].classList.remove("active");
			current = (i + slides.length) % slides.length;
			slides[current].classList.add("active");
			dotsBox.children[current].classList.add("active");
		};
		var start = function () {
			timer = setInterval(function () { go(current + 1); }, 4200);
		};

		slides.forEach(function (_, i) {
			var b = document.createElement("button");
			b.type = "button";
			b.setAttribute("aria-label", (i + 1) + "枚目の写真を表示");
			if (i === 0) b.classList.add("active");
			b.addEventListener("click", function () {
				clearInterval(timer);
				go(i);
				start();
			});
			dotsBox.appendChild(b);
		});
		start();
	}

	/* お問い合わせフォーム（FormSubmit へ AJAX 送信。JS無効時は通常POST→_next へ） */
	var form = document.getElementById("contactForm");
	var done = document.getElementById("formDone");
	if (form && done) {
		var errBox = document.getElementById("formError");
		var submitBtn = document.getElementById("formSubmit");
		var fallbackHtml = "お手数ですが、<a href=\"tel:05013821090\">お電話（050-1382-1090）</a>または<a href=\"mailto:piano.kyoshitsu.75@gmail.com\">メール</a>でご連絡ください。";

		/* チラシのQR（#contactForm）から来たら、読み込み完了後に確実にフォームへ着地させる
		   （ブラウザ標準のアンカー移動は、フォントや画像の読み込みで位置がずれたり効かなかったりするため） */
		if (location.hash === "#contactForm") {
			var landCancelled = false;
			var cancelLanding = function () { landCancelled = true; };
			["wheel", "touchstart", "keydown", "mousedown"].forEach(function (t) {
				window.addEventListener(t, cancelLanding, { passive: true, once: true });
			});
			var landOnForm = function () {
				/* 読み込み中に自分で操作した人・別の場所へ移動した人・送信完了表示中は動かさない */
				if (landCancelled || location.hash !== "#contactForm" || form.hidden) return;
				var offset = (header ? header.offsetHeight : 72) + 16;
				var y = Math.max(0, form.getBoundingClientRect().top + window.pageYOffset - offset);
				var root = document.documentElement;
				var prev = root.style.scrollBehavior;
				root.style.scrollBehavior = "auto"; /* CSSのなめらかスクロールを一時的に止めて即時に移動 */
				window.scrollTo(0, y);
				root.style.scrollBehavior = prev;
			};
			window.addEventListener("load", function () { setTimeout(landOnForm, 80); });
		}

		/* 流入元の計測：チラシのQR等（?utm_source=...）から来た人は、フォームの送信内容に「きっかけ」を自動で添える */
		(function () {
			var q = {};
			location.search.replace(/^\?/, "").split("&").forEach(function (kv) {
				if (!kv) return;
				var i = kv.indexOf("=");
				try {
					var k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, " "));
					var v = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " "));
					q[k] = v.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 60);
				} catch (e) { /* 壊れた%エンコードは無視（フォーム本体は止めない） */ }
			});
			var label = "";
			if (q.utm_source === "flyer" || q.from === "flyer") {
				var versions = { greeting: "ごあいさつ版", lesson: "レッスン案内版" };
				var ver = q.utm_content ? (Object.prototype.hasOwnProperty.call(versions, q.utm_content) ? versions[q.utm_content] : q.utm_content) : "";
				var parts = [ver, q.utm_campaign ? q.utm_campaign + "配布" : ""].filter(Boolean);
				label = "チラシのQRコード" + (parts.length ? "（" + parts.join("・") + "）" : "");
			} else if (q.utm_source) {
				label = [q.utm_source, q.utm_medium, q.utm_campaign, q.utm_content].filter(Boolean).join(" / ");
			}
			if (!label) return;
			var hidden = document.createElement("input");
			hidden.type = "hidden";
			hidden.name = "きっかけ";
			hidden.value = label;
			form.appendChild(hidden);
		})();

		var showDone = function () {
			form.hidden = true;
			done.hidden = false;
			done.classList.add("in");
			done.scrollIntoView({ block: "center" });
			done.focus({ preventScroll: true });
		};
		var showError = function (msg, withFallback) {
			errBox.innerHTML = withFallback ? (msg + "<br />" + fallbackHtml) : msg;
			errBox.hidden = false;
			submitBtn.disabled = false;
			submitBtn.textContent = "この内容で送信する";
		};

		/* JS無効時の通常POST後（?sent=1 で戻ってくる）も完了表示にする */
		if (/[?&]sent=1(&|$)/.test(location.search)) {
			showDone();
			if (history.replaceState) history.replaceState(null, "", location.pathname + "#contact");
			window.addEventListener("load", function () {
				setTimeout(function () { done.scrollIntoView({ block: "center", behavior: "instant" }); }, 60);
			});
		}

		/* AJAX送信に必要なAPIが無い古いブラウザは、標準検証のまま通常POST（_next で戻る） */
		var canAjax = typeof window.fetch === "function" && typeof window.FormData === "function" &&
			typeof window.FormData.prototype.forEach === "function";

		form.addEventListener("submit", function (ev) {
			if (!canAjax) return;
			ev.preventDefault();
			errBox.hidden = true;
			form.classList.add("was-validated");
			if (!form.checkValidity()) {
				var firstBad = form.querySelector("input:invalid, select:invalid, textarea:invalid");
				if (firstBad) firstBad.focus();
				showError("未入力の項目があります。「必須」の項目をご記入ください。");
				return;
			}
			if (form._honey && form._honey.value) return; /* bot */

			var data = {};
			new FormData(form).forEach(function (v, k) { data[k] = v; });
			delete data._next;
			var contact = data["ご連絡先（電話番号またはメールアドレス）"] || "";
			if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim())) data._replyto = contact.trim();
			data._subject = "【ホームページ】体験レッスンのお申し込み：" + (data["お名前"] || "").trim() + " 様";

			submitBtn.disabled = true;
			submitBtn.textContent = "送信中…";

			var endpoint = form.action.replace("formsubmit.co/", "formsubmit.co/ajax/");
			var ctrl = ("AbortController" in window) ? new AbortController() : null;
			var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
			fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Accept": "application/json" },
				body: JSON.stringify(data),
				signal: ctrl ? ctrl.signal : undefined
			}).then(function (r) { return r.json(); }).then(function (res) {
				if (timer) clearTimeout(timer);
				if (res && String(res.success) === "true") {
					showDone();
				} else {
					showError("送信できませんでした。", true);
				}
			}).catch(function (err) {
				if (timer) clearTimeout(timer);
				showError((err && err.name === "AbortError")
					? "送信結果を確認できませんでした（時間切れ）。すでに受け付けられている可能性があります。"
					: "通信が途切れ、送信結果を確認できませんでした。すでに受け付けられている可能性があります。", true);
			});
		});
		/* ハンドラー登録後にブラウザ標準の検証を止める（AJAXできる環境だけ。JS無効・旧ブラウザは標準の必須検証が生きる） */
		form.noValidate = canAjax;
	}
})();
