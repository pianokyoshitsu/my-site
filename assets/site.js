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
})();
