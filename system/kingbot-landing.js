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

  const year = document.getElementById("current-year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Keep native anchor behaviour; only close the mobile menu after navigation.
})();