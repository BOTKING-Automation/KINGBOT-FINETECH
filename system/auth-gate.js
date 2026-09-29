/*
=========================================================
 KINGBOT FINTECH — AUTHENTICATION GATE
 GIBSONFX TECH
=========================================================

FLOW

LOADER
   ↓
AUTH GATE
   ↓
SIGN IN / SIGN UP
   ↓
EMAIL VERIFICATION
   ↓
PLATFORM ACCESS

IMPORTANT:
- No fake authentication
- No fake verification
- No passwords stored here
- Authentication is ultimately enforced by the backend
- This file controls frontend routing only
=========================================================
*/

(function (window) {
  "use strict";

  const AUTH_GATE = {

    config: {
      protectedPages: [
        "terminal.html",
        "analytics.html",
        "ai.html",
        "bots.html",
        "settings.html",
        "subscription.html"
      ],

      authPages: [
        "signin.html",
        "signup.html",
        "access-stable.html",
        "verify.html",
        "verification.html"
      ],

      loaderPath: "loader.html",
      signInPath: "access-stable.html#signin",
      signUpPath: "access-stable.html#signup",
      verifyPath: "verify.html",
      homePath: "index.html"
    },

    // ---------------------------------------------------
    // PAGE HELPERS
    // ---------------------------------------------------

    getPageName() {

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

    isProtectedPage() {

      const page =
        this.getPageName();

      return this.config.protectedPages.includes(
        page
      );

    },

    isAuthPage() {

      const page =
        this.getPageName();

      return this.config.authPages.includes(
        page
      );

    },

    isLoaderPage() {

      return window.location.pathname
        .toLowerCase()
        .includes("/system/loader.html");

    },

    // ---------------------------------------------------
    // RETURN URL
    // ---------------------------------------------------

    getReturnUrl() {

      return (
        window.location.pathname +
        window.location.search +
        window.location.hash
      );

    },

    buildSignInUrl() {

      const returnUrl =
        this.getReturnUrl();

      return (
        "access-stable.html?return=" +
        encodeURIComponent(returnUrl) +
        "#signin"
      );

    },

    buildVerificationUrl() {

      const returnUrl =
        this.getReturnUrl();

      return (
        "verify.html?return=" +
        encodeURIComponent(returnUrl)
      );

    },

    // ---------------------------------------------------
    // AUTHENTICATION
    // ---------------------------------------------------

    async checkAuthentication() {

      if (!window.KINGBOT_SESSION) {

        console.error(
          "[KINGBOT AUTH] session.js is missing."
        );

        return {
          authenticated: false,
          verified: false,
          error: "SESSION_MANAGER_MISSING"
        };

      }

      const session =
        await window.KINGBOT_SESSION.check();

      return {
        authenticated:
          session.authenticated === true,

        verified:
          Boolean(
            session.user &&
            session.user.verified === true
          ),

        user:
          session.user || null,

        error:
          session.error || null
      };

    },

    // ---------------------------------------------------
    // MAIN ACCESS CONTROL
    // ---------------------------------------------------

    async enforce() {

      /*
      ---------------------------------------------------
      Do not run the protected-page gate on auth pages.
      ---------------------------------------------------
      */

      if (this.isAuthPage()) {

        await this.handleAuthPage();

        return;

      }

      /*
      ---------------------------------------------------
      Loader is allowed to initialize without auth.
      ---------------------------------------------------
      */

      if (this.isLoaderPage()) {
        return;
      }

      /*
      ---------------------------------------------------
      Only protected platform pages require authentication.
      ---------------------------------------------------
      */

      if (!this.isProtectedPage()) {
        return;
      }

      /*
      ---------------------------------------------------
      Check real session.
      ---------------------------------------------------
      */

      const auth =
        await this.checkAuthentication();

      /*
      ---------------------------------------------------
      NOT AUTHENTICATED
      ---------------------------------------------------
      */

      if (!auth.authenticated) {

        this.showAccessState(
          "AUTHENTICATION REQUIRED"
        );

        setTimeout(() => {

          window.location.replace(
            this.buildSignInUrl()
          );

        }, 350);

        return;

      }

      /*
      ---------------------------------------------------
      AUTHENTICATED BUT NOT VERIFIED
      ---------------------------------------------------
      */

      if (!auth.verified) {

        this.showAccessState(
          "EMAIL VERIFICATION REQUIRED"
        );

        setTimeout(() => {

          window.location.replace(
            this.buildVerificationUrl()
          );

        }, 350);

        return;

      }

      /*
      ---------------------------------------------------
      AUTHENTICATED + VERIFIED
      ---------------------------------------------------
      */

      this.grantAccess(
        auth.user
      );

    },

    // ---------------------------------------------------
    // AUTH PAGE HANDLING
    // ---------------------------------------------------

    async handleAuthPage() {

      if (!window.KINGBOT_SESSION) {
        return;
      }

      const session =
        await window.KINGBOT_SESSION.check();

      /*
      ---------------------------------------------------
      Already authenticated and verified.
      Send user into the platform.
      ---------------------------------------------------
      */

      if (
        session.authenticated === true &&
        session.user &&
        session.user.verified === true
      ) {

        /*
        Do not force redirect if user is already on a
        verification page because backend may still need
        to process a verification action.
        */

        const page =
          this.getPageName();

        if (
          page !== "verify.html" &&
          page !== "verification.html"
        ) {

          this.redirectAfterAuthentication();

        }

      }

    },

    // ---------------------------------------------------
    // ACCESS GRANTED
    // ---------------------------------------------------

    grantAccess(user) {

      document.documentElement
        .setAttribute(
          "data-kingbot-authenticated",
          "true"
        );

      document.documentElement
        .setAttribute(
          "data-kingbot-verified",
          "true"
        );

      /*
      ---------------------------------------------------
      Expose authenticated user only through the session
      manager. Never expose passwords/tokens in HTML.
      ---------------------------------------------------
      */

      if (
        window.KINGBOT_SESSION &&
        typeof window.KINGBOT_SESSION
          .updateUserElements === "function"
      ) {

        window.KINGBOT_SESSION
          .updateUserElements();

      }

      window.dispatchEvent(
        new CustomEvent(
          "kingbot:access-granted",
          {
            detail: {
              user: user || null
            }
          }
        )
      );

      console.info(
        "[KINGBOT AUTH] Platform access granted."
      );

    },

    // ---------------------------------------------------
    // REDIRECT AFTER AUTHENTICATION
    // ---------------------------------------------------

    redirectAfterAuthentication() {

      const params =
        new URLSearchParams(
          window.location.search
        );

      const returnUrl =
        params.get("return");

      /*
      ---------------------------------------------------
      SECURITY:

      Only accept same-site relative paths.

      Examples accepted:
      /KINGBOT-FINETECH/markets.html

      Examples rejected:
      https://evil-site.com
      //evil-site.com
      javascript:...
      ---------------------------------------------------
      */

      if (
        returnUrl &&
        this.isSafeReturnUrl(returnUrl)
      ) {

        window.location.replace(
          returnUrl
        );

        return;

      }

      window.location.replace(
        "index.html"
      );

    },

    // ---------------------------------------------------
    // SAFE RETURN URL
    // ---------------------------------------------------

    isSafeReturnUrl(url) {

      if (
        typeof url !== "string" ||
        !url
      ) {

        return false;

      }

      const value =
        url.trim();

      /*
      Block external URLs.
      */

      if (
        value.startsWith("//") ||
        value.includes("://") ||
        value.toLowerCase()
          .startsWith("javascript:")
      ) {

        return false;

      }

      /*
      Only local absolute paths.
      */

      if (!value.startsWith("/")) {
        return false;
      }

      /*
      Prevent authentication loops.
      */

      const lower =
        value.toLowerCase();

      if (
        lower.includes("/signin.html") ||
        lower.includes("/signup.html")
      ) {

        return false;

      }

      return true;

    },

    // ---------------------------------------------------
    // ACCESS STATE UI
    // ---------------------------------------------------

    showAccessState(message) {

      let overlay =
        document.getElementById(
          "kingbot-auth-gate"
        );

      if (!overlay) {

        overlay =
          document.createElement("div");

        overlay.id =
          "kingbot-auth-gate";

        overlay.innerHTML = `
          <div class="kingbot-auth-gate-box">

            <div class="kingbot-auth-logo">
              KING<span>BOT</span>
            </div>

            <div class="kingbot-auth-core">
              <div class="core-ring ring-one"></div>
              <div class="core-ring ring-two"></div>
              <div class="core-dot"></div>
            </div>

            <div
              class="kingbot-auth-status"
              id="kingbot-auth-status"
            >
              ${message}
            </div>

            <div class="kingbot-auth-loading">
              <span></span>
              <span></span>
              <span></span>
            </div>

            <div class="kingbot-auth-powered">
              POWERED BY GIBSONFX TECH
            </div>

          </div>
        `;

        document.body.appendChild(
          overlay
        );

        this.injectGateStyles();

      } else {

        const status =
          document.getElementById(
            "kingbot-auth-status"
          );

        if (status) {
          status.textContent =
            message;
        }

      }

    },

    // ---------------------------------------------------
    // GATE STYLES
    // ---------------------------------------------------

    injectGateStyles() {

      if (
        document.getElementById(
          "kingbot-auth-gate-style"
        )
      ) {

        return;

      }

      const style =
        document.createElement("style");

      style.id =
        "kingbot-auth-gate-style";

      style.textContent = `

        #kingbot-auth-gate {

          position: fixed;
          inset: 0;
          z-index: 999999;

          display: flex;
          align-items: center;
          justify-content: center;

          background:
            radial-gradient(
              circle at center,
              rgba(20,35,80,.72),
              rgba(2,4,12,.98) 65%
            );

          backdrop-filter: blur(18px);

          color: #eef2ff;

          font-family:
            Inter,
            system-ui,
            sans-serif;

        }

        .kingbot-auth-gate-box {

          width: min(
            420px,
            calc(100vw - 40px)
          );

          padding: 42px 30px;

          text-align: center;

          border:
            1px solid
            rgba(246,185,59,.35);

          border-radius: 24px;

          background:
            linear-gradient(
              145deg,
              rgba(10,18,40,.94),
              rgba(3,6,18,.97)
            );

          box-shadow:
            0 0 80px
            rgba(77,141,255,.12),

            inset 0 0 50px
            rgba(255,255,255,.025);

        }

        .kingbot-auth-logo {

          font-family:
            Orbitron,
            system-ui,
            sans-serif;

          font-size: 27px;

          font-weight: 900;

          letter-spacing: 3px;

          color: #f6b93b;

          margin-bottom: 28px;

        }

        .kingbot-auth-logo span {

          color: #eef2ff;

        }

        .kingbot-auth-core {

          position: relative;

          width: 100px;
          height: 100px;

          margin:
            0 auto 28px;

          display: flex;

          align-items: center;
          justify-content: center;

        }

        .core-ring {

          position: absolute;

          inset: 0;

          border-radius: 50%;

          border:
            1px solid
            rgba(25,230,255,.35);

          animation:
            kingbotSpin 4s linear infinite;

        }

        .ring-two {

          inset: 12px;

          border-color:
            rgba(246,185,59,.55);

          animation-duration: 2.8s;

          animation-direction:
            reverse;

        }

        .core-dot {

          width: 25px;
          height: 25px;

          border-radius: 50%;

          background: #19e6ff;

          box-shadow:
            0 0 12px #19e6ff,
            0 0 30px rgba(25,230,255,.65);

          animation:
            kingbotPulse 1.5s ease-in-out infinite;

        }

        .kingbot-auth-status {

          font-family:
            Orbitron,
            system-ui,
            sans-serif;

          font-size: 13px;

          font-weight: 700;

          letter-spacing: 1.5px;

          color: #f6b93b;

          min-height: 20px;

        }

        .kingbot-auth-loading {

          display: flex;

          justify-content: center;

          gap: 6px;

          margin-top: 20px;

        }

        .kingbot-auth-loading span {

          width: 6px;
          height: 6px;

          border-radius: 50%;

          background: #19e6ff;

          animation:
            kingbotDots 1.2s infinite;

        }

        .kingbot-auth-loading span:nth-child(2) {

          animation-delay: .15s;

        }

        .kingbot-auth-loading span:nth-child(3) {

          animation-delay: .3s;

        }

        .kingbot-auth-powered {

          margin-top: 28px;

          font-size: 9px;

          letter-spacing: 2px;

          color: rgba(238,242,255,.4);

        }

        @keyframes kingbotSpin {

          from {
            transform: rotate(0deg);
          }

          to {
            transform: rotate(360deg);
          }

        }

        @keyframes kingbotPulse {

          0%, 100% {
            transform: scale(.8);
            opacity: .65;
          }

          50% {
            transform: scale(1);
            opacity: 1;
          }

        }

        @keyframes kingbotDots {

          0%, 80%, 100% {
            transform: translateY(0);
            opacity: .35;
          }

          40% {
            transform: translateY(-5px);
            opacity: 1;
          }

        }

        @media (
          prefers-reduced-motion: reduce
        ) {

          .core-ring,
          .core-dot,
          .kingbot-auth-loading span {

            animation: none;

          }

        }

      `;

      document.head.appendChild(
        style
      );

    },

    // ---------------------------------------------------
    // LOGOUT
    // ---------------------------------------------------

    async logout() {

      if (
        window.KINGBOT_SESSION &&
        typeof window.KINGBOT_SESSION.logout ===
          "function"
      ) {

        await window.KINGBOT_SESSION.logout({
          redirect: true
        });

        return;

      }

      window.location.replace(
        "signin.html"
      );

    }

  };

  // -----------------------------------------------------
  // GLOBAL API
  // -----------------------------------------------------

  window.KINGBOT_AUTH =
    AUTH_GATE;

  // -----------------------------------------------------
  // INITIALIZATION
  // -----------------------------------------------------

  document.addEventListener(
    "DOMContentLoaded",
    async () => {

      /*
      Give session.js time to initialize.
      */

      if (!window.KINGBOT_SESSION) {

        console.warn(
          "[KINGBOT AUTH] Waiting for session manager..."
        );

        return;

      }

      await AUTH_GATE.enforce();

    }
  );

})(window);
