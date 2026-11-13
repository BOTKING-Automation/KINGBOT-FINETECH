/* KINGBOT FINETECH — public landing interactions only. */
(function () {
  "use strict";

  const menuButton = document.querySelector(".menu-toggle");
  const navigation = document.getElementById("primary-navigation");

  function closeMenu() {
    if (!menuButton || !navigation) return;
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation");
    navigation.classList.remove("is-open");
  }

  if (menuButton && navigation) {
    menuButton.addEventListener("click", function () {
      const isOpen = menuButton.getAttribute("aria-expanded") === "true";
      menuButton.setAttribute("aria-expanded", String(!isOpen));
      menuButton.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
      navigation.classList.toggle("is-open", !isOpen);
    });

    navigation.addEventListener("click", function (event) {
      if (event.target.closest("a")) closeMenu();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeMenu();
        menuButton.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (!navigation.contains(event.target) && !menuButton.contains(event.target)) {
        closeMenu();
      }
    });

    window.addEventListener("resize", function () {
      if (window.matchMedia("(min-width: 821px)").matches) closeMenu();
    });
  }

  // Premium per-engine pricing with a prepaid three-month offer.
  const billingButtons = document.querySelectorAll("[data-landing-billing]");
  const priceCards = document.querySelectorAll("[data-bot-plan]");

  function updateLandingPricing(months) {
    const term = Number(months) === 3 ? 3 : 1;
    billingButtons.forEach(function (button) {
      const active = Number(button.dataset.landingBilling) === term;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    priceCards.forEach(function (card) {
      const monthly = Number(card.dataset.monthlyPrice);
      if (!Number.isFinite(monthly) || monthly <= 0) return;
      const full = monthly * term;
      const total = term === 3 ? Number((full * 0.7).toFixed(2)) : monthly;
      const price = card.querySelector("[data-live-price]");
      const period = card.querySelector("[data-live-period]");
      const offer = card.querySelector("[data-live-offer]");
      const link = card.querySelector("[data-plan-link]");

      if (price) price.textContent = "$" + (term === 3 ? total.toFixed(2) : String(monthly));
      if (period) period.textContent = term === 3 ? "/ 3 months prepaid" : "/ month";
      if (offer) {
        offer.textContent = term === 3
          ? "SAVE 30% · WAS $" + full.toFixed(2) + " · YOU SAVE $" + (full - total).toFixed(2)
          : "Prepay 3 months and save 30%";
      }
      if (link) {
        const plan = link.dataset.planLink;
        link.href = "access-stable.html?return=subscription.html%3Fplan%3D" +
          encodeURIComponent(plan) + "%26months%3D" + term + "%23signin#signup";
      }
    });
  }

  billingButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      updateLandingPricing(button.dataset.landingBilling);
    });
  });
  updateLandingPricing(1);

  const year = document.getElementById("current-year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Keep native anchor behaviour; only close the mobile menu after navigation.
})();