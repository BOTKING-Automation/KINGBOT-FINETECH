/* KINGBOT FINTECH — accessible landing-page motion */
(function () {
  "use strict";

  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const revealTargets = document.querySelectorAll(
    ".overview-copy, .overview-item, #bots .sec-tag, #bots h2, #bots .sec-sub, #bots .bot-card, .market-grid > div, .market-category, #pricing .pricing-head, #pricing .plan, .final-cta"
  );

  if (!revealTargets.length) return;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealTargets.forEach((element) => element.classList.add("kb-in-view"));
    return;
  }

  document.body.classList.add("kb-motion-ready");

  revealTargets.forEach((element, index) => {
    element.classList.add("kb-reveal");
    element.style.setProperty("--kb-reveal-delay", String((index % 5) * 65) + "ms");
  });

  const observer = new IntersectionObserver((entries, activeObserver) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("kb-in-view");
      activeObserver.unobserve(entry.target);
    });
  }, {
    root: null,
    rootMargin: "0px 0px -48px 0px",
    threshold: 0.12
  });

  revealTargets.forEach((element) => observer.observe(element));
})();
