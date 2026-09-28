/*
=========================================================
 KINGBOT FINTECH — UNIVERSAL NAVIGATION SYSTEM
 GIBSONFX TECH
=========================================================

PURPOSE
- One navigation structure across KINGBOT pages
- Automatic active-page detection
- Mobile navigation support
- Account menu support
- Session-aware user display
- Safe logout
- Does NOT contain fake authentication
- Does NOT contain trading logic
=========================================================
*/

(function (window, document) {
  "use strict";

  const KINGBOT_NAV = {

    config: {

      brand: "KINGBOT",

      links: [
        {
          label: "Home",
          href: "index.html",
          icon: "⌂",
          permission: "platform"
        },

        {
          label: "Markets",
          href: "markets.html",
          icon: "◈",
          permission: "markets"
        },

        {
          label: "Terminal",
          href: "terminal.html",
          icon: "▣",
          permission: "terminal"
        },

        {
          label: "Bots",
          href: "bots.html",
          icon: "◉",
          permission: "bots"
        },

        {
          label: "Analytics",
          href: "analytics.html",
          icon: "◫",
          permission: "analytics"
        },

        {
          label: "AI Intelligence",
          href: "ai.html",
          icon: "✦",
          permission: "ai"
        }
      ],

      accountLinks: [
        {
          label: "Profile",
          href: "profile.html",
          icon: "◎"
        },

        {
          label: "Settings",
          href: "settings.html",
          icon: "⚙"
        }
      ]

    },

    state: {
      initialized: false,
      mobileOpen: false,
      user: null
    },


    /*
    =====================================================
     INITIALIZE
    =====================================================
    */

    async initialize() {

      if (this.state.initialized) {
        return;
      }

      this.injectStyles();

      await this.loadUser();

      this.markExistingNavigation();

      this.state.initialized = true;

      window.dispatchEvent(
        new CustomEvent(
          "kingbot:navigation-ready"
        )
      );

    },


    /*
    =====================================================
     LOAD SESSION USER
    =====================================================
    */

    async loadUser() {

      try {

        if (
          window.KINGBOT_SESSION &&
          typeof window.KINGBOT_SESSION.check === "function"
        ) {

          const session =
            await window.KINGBOT_SESSION.check();

          if (
            session &&
            session.authenticated &&
            session.user
          ) {

            this.state.user = session.user;

          }

        }

      } catch (error) {

        console.warn(
          "[KINGBOT NAV] Session user unavailable."
        );

      }

    },


    /*
    =====================================================
     CURRENT PAGE
    =====================================================
    */

    getCurrentPage() {

      const path =
        window.location.pathname
          .split("/")
          .filter(Boolean)
          .pop();

      return (
        path ||
        "index.html"
      ).toLowerCase();

    },


    /*
    =====================================================
     ACTIVE LINK
    =====================================================
    */

    isActive(href) {

      return (
        this.getCurrentPage() ===
        href.toLowerCase()
      );

    },


    /*
    =====================================================
     PERMISSION CHECK
    =====================================================
    */

    canShow(link) {

      if (!link.permission) {
        return true;
      }

      if (
        window.KINGBOT_ACCESS &&
        typeof window.KINGBOT_ACCESS.can === "function"
      ) {

        /*
         Do not hide Markets.
         Markets can remain publicly visible.
        */

        if (
          link.permission === "markets"
        ) {

          return true;

        }

        return window.KINGBOT_ACCESS.can(
          link.permission
        );

      }

      /*
       Until access-control is loaded,
       keep the navigation visible.
      */

      return true;

    },


    /*
    =====================================================
     BUILD NAVIGATION
    =====================================================
    */

    buildNavigation() {

      const links =
        this.config.links
          .filter(link => this.canShow(link))
          .map(link => {

            const active =
              this.isActive(link.href)
                ? "active"
                : "";

            return `
              <a
                class="kb-nav-link ${active}"
                href="${link.href}"
                data-kb-nav="${link.href}"
              >

                <span class="kb-nav-icon">
                  ${link.icon}
                </span>

                <span class="kb-nav-label">
                  ${link.label}
                </span>

              </a>
            `;

          })
          .join("");

      return links;

    },


    /*
    =====================================================
     BUILD ACCOUNT MENU
    =====================================================
    */

    buildAccountMenu() {

      const accountLinks =
        this.config.accountLinks
          .map(link => {

            return `
              <a
                class="kb-account-link"
                href="${link.href}"
              >

                <span>
                  ${link.icon}
                </span>

                ${link.label}

              </a>
            `;

          })
          .join("");

      return `
        <div
          class="kb-account-menu"
          id="kb-account-menu"
        >

          <div class="kb-account-header">

            <div class="kb-avatar">
              ${this.getInitials()}
            </div>

            <div class="kb-account-info">

              <strong>
                ${this.escapeHTML(
                  this.getDisplayName()
                )}
              </strong>

              <span>
                ${this.escapeHTML(
                  this.getEmail()
                )}
              </span>

            </div>

          </div>

          <div class="kb-account-divider"></div>

          ${accountLinks}

          <button
            type="button"
            class="kb-account-link kb-logout"
            id="kb-logout"
          >

            <span>↪</span>

            Sign Out

          </button>

        </div>
      `;

    },


    /*
    =====================================================
     DISPLAY USER
    =====================================================
    */

    getDisplayName() {

      if (!this.state.user) {
        return "KINGBOT User";
      }

      return (
        this.state.user.name ||
        this.state.user.displayName ||
        this.state.user.email ||
        "KINGBOT User"
      );

    },


    getEmail() {

      if (!this.state.user) {
        return "Secure Account";
      }

      return (
        this.state.user.email ||
        "Secure Account"
      );

    },


    getInitials() {

      const name =
        this.getDisplayName();

      if (!name) {
        return "KB";
      }

      const parts =
        name
          .trim()
          .split(/\s+/)
          .slice(0, 2);

      if (parts.length === 1) {

        return parts[0]
          .substring(0, 2)
          .toUpperCase();

      }

      return (
        parts[0][0] +
        parts[1][0]
      ).toUpperCase();

    },


    /*
    =====================================================
     RENDER UNIVERSAL NAV
    =====================================================
    */

    render() {

      /*
       Do not duplicate navigation.
      Existing page nav remains untouched for now.
      The integration phase will replace/standardize it.
      */

      const existing =
        document.querySelector(
          "[data-kingbot-navigation]"
        );

      if (!existing) {
        return;
      }

      existing.innerHTML = `

        <div class="kb-nav-shell">

          <a
            href="index.html"
            class="kb-brand"
            aria-label="KINGBOT Home"
          >

            <span class="kb-brand-mark">

              <span class="kb-brand-core">
                K
              </span>

            </span>

            <span class="kb-brand-text">

              <strong>
                KING<span>BOT</span>
              </strong>

              <small>
                FINTECH
              </small>

            </span>

          </a>


          <button
            type="button"
            class="kb-mobile-toggle"
            id="kb-mobile-toggle"
            aria-label="Open navigation"
            aria-expanded="false"
          >

            <span></span>
            <span></span>
            <span></span>

          </button>


          <nav
            class="kb-nav-links"
            id="kb-nav-links"
            aria-label="KINGBOT Navigation"
          >

            ${this.buildNavigation()}

          </nav>


          <div class="kb-nav-actions">

            <div
              class="kb-system-status"
              title="KINGBOT system status"
            >

              <span class="kb-status-dot"></span>

              <span>
                SYSTEM
              </span>

            </div>


            <button
              type="button"
              class="kb-account-button"
              id="kb-account-button"
              aria-expanded="false"
              aria-controls="kb-account-menu"
            >

              <span class="kb-avatar kb-avatar-small">
                ${this.getInitials()}
              </span>

              <span class="kb-account-name">
                ${this.escapeHTML(
                  this.getDisplayName()
                )}
              </span>

              <span class="kb-account-arrow">
                ▾
              </span>

            </button>

            ${this.buildAccountMenu()}

          </div>

        </div>

      `;

      this.bindEvents();

    },


    /*
    =====================================================
     BIND EVENTS
    =====================================================
    */

    bindEvents() {

      const mobileToggle =
        document.getElementById(
          "kb-mobile-toggle"
        );

      const navLinks =
        document.getElementById(
          "kb-nav-links"
        );

      const accountButton =
        document.getElementById(
          "kb-account-button"
        );

      const accountMenu =
        document.getElementById(
          "kb-account-menu"
        );

      const logoutButton =
        document.getElementById(
          "kb-logout"
        );


      /*
       Mobile menu
      */

      if (mobileToggle && navLinks) {

        mobileToggle.addEventListener(
          "click",
          () => {

            this.state.mobileOpen =
              !this.state.mobileOpen;

            navLinks.classList.toggle(
              "open",
              this.state.mobileOpen
            );

            mobileToggle.classList.toggle(
              "open",
              this.state.mobileOpen
            );

            mobileToggle.setAttribute(
              "aria-expanded",
              String(
                this.state.mobileOpen
              )
            );

          }
        );

      }


      /*
       Close mobile menu after navigation
      */

      if (navLinks) {

        navLinks
          .querySelectorAll("a")
          .forEach(link => {

            link.addEventListener(
              "click",
              () => {

                this.state.mobileOpen =
                  false;

                navLinks.classList.remove(
                  "open"
                );

                if (mobileToggle) {

                  mobileToggle.classList.remove(
                    "open"
                  );

                  mobileToggle.setAttribute(
                    "aria-expanded",
                    "false"
                  );

                }

              }
            );

          });

      }


      /*
       Account menu
      */

      if (
        accountButton &&
        accountMenu
      ) {

        accountButton.addEventListener(
          "click",
          event => {

            event.stopPropagation();

            const open =
              accountMenu.classList.toggle(
                "open"
              );

            accountButton.setAttribute(
              "aria-expanded",
              String(open)
            );

          }
        );

      }


      /*
       Close account menu
      */

      document.addEventListener(
        "click",
        event => {

          if (
            accountMenu &&
            accountButton &&
            !accountMenu.contains(event.target) &&
            !accountButton.contains(event.target)
          ) {

            accountMenu.classList.remove(
              "open"
            );

            accountButton.setAttribute(
              "aria-expanded",
              "false"
            );

          }

        }
      );


      /*
       Logout
      */

      if (logoutButton) {

        logoutButton.addEventListener(
          "click",
          async () => {

            logoutButton.disabled = true;

            logoutButton.innerHTML =
              "<span>⋯</span> Signing Out";

            try {

              if (
                window.KINGBOT_SESSION &&
                typeof window.KINGBOT_SESSION.logout ===
                  "function"
              ) {

                await window.KINGBOT_SESSION.logout();

              } else {

                window.location.href =
                  "signin.html";

              }

            } catch (error) {

              console.error(
                "[KINGBOT NAV] Logout failed:",
                error
              );

              window.location.href =
                "signin.html";

            }

          }
        );

      }

    },


    /*
    =====================================================
     EXISTING NAV DETECTION
    =====================================================
    */

    markExistingNavigation() {

      /*
       During the transition phase,
       don't destroy the existing navigation.
       We only prepare the page for the
       universal navigation system.
      */

      const nav =
        document.querySelector(
          "nav"
        );

      if (!nav) {
        return;
      }

      nav.setAttribute(
        "data-kb-existing-nav",
        "true"
      );

      /*
       Mark active links.
      */

      const current =
        this.getCurrentPage();

      nav
        .querySelectorAll("a[href]")
        .forEach(link => {

          const href =
            link
              .getAttribute("href")
              ?.split("#")[0]
              ?.split("?")[0]
              ?.toLowerCase();

          if (
            href &&
            href === current
          ) {

            link.classList.add(
              "kb-auto-active"
            );

          }

        });

    },


    /*
    =====================================================
     ESCAPE HTML
    =====================================================
    */

    escapeHTML(value) {

      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    },


    /*
    =====================================================
     STYLES
    =====================================================
    */

    injectStyles() {

      if (
        document.getElementById(
          "kingbot-navigation-style"
        )
      ) {

        return;

      }

      const style =
        document.createElement(
          "style"
        );

      style.id =
        "kingbot-navigation-style";

      style.textContent = `

        /*
        ================================================
        KINGBOT UNIVERSAL NAVIGATION
        ================================================
        */

        .kb-nav-shell {

          width: 100%;
          min-height: 72px;

          display: flex;
          align-items: center;

          gap: 24px;

          padding:
            0 24px;

          box-sizing: border-box;

        }


        /*
        BRAND
        */

        .kb-brand {

          display: inline-flex;

          align-items: center;

          gap: 11px;

          text-decoration: none;

          flex-shrink: 0;

        }


        .kb-brand-mark {

          width: 38px;
          height: 38px;

          display: grid;
          place-items: center;

          border-radius: 11px;

          border:
            1px solid
            rgba(246,185,59,.45);

          background:
            linear-gradient(
              145deg,
              rgba(246,185,59,.16),
              rgba(25,230,255,.08)
            );

          box-shadow:
            0 0 24px
            rgba(246,185,59,.08);

        }


        .kb-brand-core {

          font-family:
            Orbitron,
            system-ui,
            sans-serif;

          font-size: 17px;

          font-weight: 900;

          color:
            #f6b93b;

        }


        .kb-brand-text {

          display: flex;

          flex-direction: column;

          line-height: 1;

        }


        .kb-brand-text strong {

          font-family:
            Orbitron,
            system-ui,
            sans-serif;

          font-size: 16px;

          letter-spacing: 2px;

          color:
            #eef2ff;

        }


        .kb-brand-text strong span {

          color:
            #f6b93b;

        }


        .kb-brand-text small {

          margin-top: 5px;

          font-family:
            JetBrains Mono,
            monospace;

          font-size: 7px;

          letter-spacing: 2.5px;

          color:
            rgba(238,242,255,.42);

        }


        /*
        NAV LINKS
        */

        .kb-nav-links {

          display: flex;

          align-items: center;

          gap: 4px;

          flex: 1;

        }


        .kb-nav-link {

          position: relative;

          display: inline-flex;

          align-items: center;

          gap: 7px;

          min-height: 40px;

          padding:
            0 11px;

          border-radius: 9px;

          color:
            rgba(238,242,255,.62);

          text-decoration: none;

          font-size: 12px;

          font-weight: 700;

          white-space: nowrap;

          transition:
            color .2s ease,
            background .2s ease,
            transform .2s ease;

        }


        .kb-nav-link:hover {

          color:
            #eef2ff;

          background:
            rgba(255,255,255,.045);

          transform:
            translateY(-1px);

        }


        .kb-nav-link.active,
        .kb-nav-link.kb-auto-active {

          color:
            #f6b93b;

          background:
            rgba(246,185,59,.075);

        }


        .kb-nav-link.active::after,
        .kb-nav-link.kb-auto-active::after {

          content: "";

          position: absolute;

          left: 12px;
          right: 12px;
          bottom: 2px;

          height: 2px;

          border-radius: 10px;

          background:
            #f6b93b;

          box-shadow:
            0 0 12px
            rgba(246,185,59,.65);

        }


        .kb-nav-icon {

          font-size: 13px;

          opacity: .75;

        }


        /*
        ACTIONS
        */

        .kb-nav-actions {

          position: relative;

          display: flex;

          align-items: center;

          gap: 12px;

          flex-shrink: 0;

        }


        .kb-system-status {

          display: inline-flex;

          align-items: center;

          gap: 7px;

          padding:
            7px 10px;

          border:
            1px solid
            rgba(46,230,168,.14);

          border-radius: 999px;

          color:
            rgba(238,242,255,.45);

          font-family:
            JetBrains Mono,
            monospace;

          font-size: 9px;

          letter-spacing: 1px;

        }


        .kb-status-dot {

          width: 6px;
          height: 6px;

          border-radius: 50%;

          background:
            #2ee6a8;

          box-shadow:
            0 0 10px
            rgba(46,230,168,.75);

          animation:
            kbStatusPulse
            1.8s ease-in-out infinite;

        }


        @keyframes kbStatusPulse {

          0%,
          100% {

            opacity: .45;
            transform: scale(.85);

          }

          50% {

            opacity: 1;
            transform: scale(1.15);

          }

        }


        /*
        ACCOUNT BUTTON
        */

        .kb-account-button {

          display: inline-flex;

          align-items: center;

          gap: 8px;

          padding:
            5px 9px 5px 5px;

          border:
            1px solid
            rgba(255,255,255,.08);

          border-radius: 11px;

          background:
            rgba(255,255,255,.025);

          color:
            #eef2ff;

          cursor: pointer;

          transition:
            .2s ease;

        }


        .kb-account-button:hover {

          border-color:
            rgba(246,185,59,.28);

          background:
            rgba(246,185,59,.045);

        }


        .kb-avatar {

          width: 34px;
          height: 34px;

          display: grid;
          place-items: center;

          border-radius: 10px;

          background:
            linear-gradient(
              135deg,
              rgba(246,185,59,.22),
              rgba(25,230,255,.14)
            );

          border:
            1px solid
            rgba(246,185,59,.28);

          color:
            #f6b93b;

          font-family:
            Orbitron,
            system-ui,
            sans-serif;

          font-size: 10px;

          font-weight: 900;

        }


        .kb-avatar-small {

          width: 29px;
          height: 29px;

          border-radius: 8px;

        }


        .kb-account-name {

          max-width: 115px;

          overflow: hidden;

          text-overflow: ellipsis;

          white-space: nowrap;

          font-size: 11px;

          font-weight: 700;

        }


        .kb-account-arrow {

          color:
            rgba(238,242,255,.4);

          font-size: 11px;

        }


        /*
        ACCOUNT MENU
        */

        .kb-account-menu {

          position: absolute;

          top:
            calc(100% + 10px);

          right: 0;

          width: 255px;

          padding: 10px;

          display: none;

          z-index: 99999;

          border:
            1px solid
            rgba(246,185,59,.18);

          border-radius: 16px;

          background:
            rgba(6,11,26,.97);

          backdrop-filter:
            blur(20px);

          box-shadow:
            0 25px 80px
            rgba(0,0,0,.45);

        }


        .kb-account-menu.open {

          display: block;

          animation:
            kbAccountIn
            .18s ease both;

        }


        @keyframes kbAccountIn {

          from {

            opacity: 0;
            transform:
              translateY(-5px);

          }

          to {

            opacity: 1;
            transform:
              translateY(0);

          }

        }


        .kb-account-header {

          display: flex;

          align-items: center;

          gap: 11px;

          padding: 10px;

        }


        .kb-account-info {

          min-width: 0;

          display: flex;

          flex-direction: column;

          gap: 4px;

        }


        .kb-account-info strong {

          overflow: hidden;

          text-overflow: ellipsis;

          white-space: nowrap;

          font-size: 12px;

          color:
            #eef2ff;

        }


        .kb-account-info span {

          overflow: hidden;

          text-overflow: ellipsis;

          white-space: nowrap;

          font-family:
            JetBrains Mono,
            monospace;

          font-size: 9px;

          color:
            rgba(238,242,255,.4);

        }


        .kb-account-divider {

          height: 1px;

          margin:
            5px 0 8px;

          background:
            rgba(255,255,255,.07);

        }


        .kb-account-link {

          width: 100%;

          display: flex;

          align-items: center;

          gap: 10px;

          padding:
            11px;

          border: 0;

          border-radius: 9px;

          background:
            transparent;

          color:
            rgba(238,242,255,.68);

          text-decoration: none;

          font-size: 11px;

          font-weight: 700;

          text-align: left;

          cursor: pointer;

        }


        .kb-account-link:hover {

          color:
            #eef2ff;

          background:
            rgba(255,255,255,.045);

        }


        .kb-logout {

          color:
            #ff6b83;

        }


        .kb-logout:hover {

          color:
            #ff6b83;

          background:
            rgba(255,77,109,.07);

        }


        /*
        MOBILE TOGGLE
        */

        .kb-mobile-toggle {

          display: none;

          width: 42px;
          height: 42px;

          padding: 9px;

          border:
            1px solid
            rgba(255,255,255,.1);

          border-radius: 10px;

          background:
            rgba(255,255,255,.025);

          cursor: pointer;

        }


        .kb-mobile-toggle span {

          display: block;

          height: 2px;

          margin:
            4px 0;

          border-radius: 5px;

          background:
            #eef2ff;

          transition:
            .2s ease;

        }


        .kb-mobile-toggle.open
        span:nth-child(1) {

          transform:
            translateY(6px)
            rotate(45deg);

        }


        .kb-mobile-toggle.open
        span:nth-child(2) {

          opacity: 0;

        }


        .kb-mobile-toggle.open
        span:nth-child(3) {

          transform:
            translateY(-6px)
            rotate(-45deg);

        }


        /*
        ================================================
        RESPONSIVE
        ================================================
        */

        @media (max-width: 1100px) {

          .kb-nav-shell {

            gap: 14px;

            padding:
              0 16px;

          }

          .kb-nav-link {

            padding:
              0 8px;

          }

          .kb-nav-label {

            font-size: 11px;

          }

          .kb-system-status {

            display: none;

          }

        }


        @media (max-width: 850px) {

          .kb-mobile-toggle {

            display: block;

            margin-left: auto;

          }


          .kb-nav-links {

            position: absolute;

            left: 12px;
            right: 12px;

            top:
              calc(100% + 8px);

            display: none;

            flex-direction: column;

            align-items: stretch;

            padding: 10px;

            border:
              1px solid
              rgba(246,185,59,.15);

            border-radius: 16px;

            background:
              rgba(5,10,24,.98);

            backdrop-filter:
              blur(22px);

            box-shadow:
              0 25px 70px
              rgba(0,0,0,.45);

            z-index: 99990;

          }


          .kb-nav-links.open {

            display: flex;

            animation:
              kbMobileNavIn
              .18s ease both;

          }


          @keyframes kbMobileNavIn {

            from {

              opacity: 0;

              transform:
                translateY(-7px);

            }

            to {

              opacity: 1;

              transform:
                translateY(0);

            }

          }


          .kb-nav-link {

            min-height: 45px;

            width: 100%;

            box-sizing: border-box;

          }


          .kb-nav-link.active::after,
          .kb-nav-link.kb-auto-active::after {

            left: 5px;
            right: auto;

            top: 9px;
            bottom: 9px;

            width: 2px;
            height: auto;

          }


          .kb-account-name,
          .kb-account-arrow {

            display: none;

          }

        }


        @media (max-width: 560px) {

          .kb-nav-shell {

            min-height: 64px;

            padding:
              0 12px;

          }


          .kb-brand-text small {

            display: none;

          }


          .kb-brand-text strong {

            font-size: 14px;

          }


          .kb-brand-mark {

            width: 34px;
            height: 34px;

          }


          .kb-account-button {

            padding:
              4px;

          }

        }

      `;

      document.head.appendChild(style);

    }

  };


  /*
  =====================================================
   GLOBAL OBJECT
  =====================================================
  */

  window.KINGBOT_NAV =
    KINGBOT_NAV;


  /*
  =====================================================
   AUTO START
  =====================================================
  */

  document.addEventListener(
    "DOMContentLoaded",
    async () => {

      await KINGBOT_NAV.initialize();

      /*
       Only render when a page explicitly
       contains the universal navigation mount.
      */

      KINGBOT_NAV.render();

    }
  );


})(window);
