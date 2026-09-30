/*
=========================================================
 KINGBOT FINTECH — ACCESS CONTROL
 GIBSONFX TECH
=========================================================

PURPOSE
---------------------------------------------------------
Controls frontend access to KINGBOT features.

IMPORTANT
---------------------------------------------------------
This is a UI/access layer.

Real authorization MUST eventually be enforced by the
backend. Never trust browser-side permissions for:
- placing trades
- broker credentials
- withdrawals
- subscription billing
- account changes
- administrative actions

No fake subscription status.
No fake broker status.
No fake trading permissions.
=========================================================
*/

(function (window) {
  "use strict";

  const ACCESS_CONTROL = {

    // ---------------------------------------------------
    // Default configuration
    // ---------------------------------------------------

    config: {

      /*
      Features that will eventually be returned by the
      authenticated backend.
      */

      defaultPermissions: {
        platform: false,
        markets: true,
        terminal: false,
        analytics: false,
        ai: false,
        bots: false,
        broker: false,
        trading: false,
        withdrawals: false,
        billing: false,
        admin: false
      },

      /*
      Backend endpoint that will eventually provide
      subscription + permission information.
      */

      permissionsEndpoint:
        "/subscription/me"

    },

    // ---------------------------------------------------
    // State
    // ---------------------------------------------------

    state: {

      loaded: false,

      loading: false,

      authenticated: false,

      verified: false,

      isAdmin: false,

      subscription: null,

      permissions: {},

      error: null,

      checkedAt: 0,
      expiryTimer: null

    },

    // ---------------------------------------------------
    // Initialize
    // ---------------------------------------------------

    async initialize() {

      if (this.state.loading) {
        return this.getState();
      }

      this.state.loading = true;

      this.state.error = null;

      try {

        /*
        -------------------------------------------------
        Require the session manager.
        -------------------------------------------------
        */

        if (!window.KINGBOT_SESSION) {

          throw new Error(
            "KINGBOT_SESSION is not available."
          );

        }

        const session =
          await window.KINGBOT_SESSION.check();

        this.state.authenticated =
          session.authenticated === true;

        this.state.isAdmin = false;

        this.state.verified =
          Boolean(
            session.user &&
            session.user.verified === true
          );

        /*
        -------------------------------------------------
        Guest users receive only public permissions.
        -------------------------------------------------
        */

        if (!this.state.authenticated) {

          this.state.permissions = {
            ...this.config.defaultPermissions,
            markets: true
          };

          this.state.loaded = true;
          this.state.checkedAt = Date.now();

          return this.getState();

        }

        /*
        -------------------------------------------------
        Authenticated users will eventually have their
        real permissions loaded from the backend.
        -------------------------------------------------
        */

        const response =
          await window.KINGBOT_API.request(
            this.config.permissionsEndpoint,
            {
              method: "GET",
              headers: {
                "Cache-Control": "no-cache"
              }
            }
          );

        /*
        -------------------------------------------------
        Endpoint does not exist yet.
        -------------------------------------------------

        This is expected before the backend is built.

        We do NOT grant access automatically.
        -------------------------------------------------
        */

        if (response.status === 404) {

          console.info(
            "[KINGBOT ACCESS] Permission API is not connected yet."
          );

          this.state.permissions = {
            ...this.config.defaultPermissions,
            markets: true
          };

          this.state.loaded = true;
          this.state.checkedAt = Date.now();

          return this.getState();

        }

        if (
          response.status === 401 ||
          response.status === 403
        ) {

          this.state.permissions = {
            ...this.config.defaultPermissions,
            markets: true
          };

          this.state.loaded = true;
          this.state.checkedAt = Date.now();

          return this.getState();

        }

        if (!response.ok) {

          throw new Error(
            `Permission request failed: HTTP ${response.status}`
          );

        }

        const data =
          await response.json();

        /*
        -------------------------------------------------
        Read only explicitly returned permissions.
        -------------------------------------------------
        */

        const administrator = data.isAdmin === true;
        this.state.isAdmin = administrator;
        this.state.permissions = {
          ...this.config.defaultPermissions,
          ...(() => {
            const active=Boolean(data.subscription);
            const pro=["pro","institutional"].includes(String(data.subscription?.plan_id||""));
            const entitlements=Array.isArray(data.entitlements)?data.entitlements:[];
            return administrator
              ? {platform:true,markets:true,terminal:true,analytics:true,ai:true,bots:true,broker:true,trading:true,withdrawals:false,billing:true,admin:true}
              : {platform:true,markets:true,terminal:active,analytics:active,ai:active&&pro,bots:active&&entitlements.length>0,broker:active,trading:active,withdrawals:false,billing:true,admin:false};
          })()
        };

        this.state.subscription =
          data.subscription ? {
            ...data.subscription,
            active:true,
            plan:data.subscription.plan_id
          } : null;

        this.scheduleExpiryRefresh();

        this.state.loaded = true;
        this.state.checkedAt = Date.now();

        return this.getState();

      } catch (error) {

        console.error(
          "[KINGBOT ACCESS] Permission check failed:",
          error
        );

        this.state.error = error;

        /*
        -------------------------------------------------
        FAIL CLOSED

        No sensitive platform functionality is granted
        if permission data cannot be verified.
        -------------------------------------------------
        */

        this.state.permissions = {
          ...this.config.defaultPermissions,
          markets: true
        };

        this.state.loaded = true;
        this.state.checkedAt = Date.now();

        return this.getState();

      } finally {

        this.state.loading = false;

      }

    },

    // ---------------------------------------------------
    // State
    // ---------------------------------------------------

    getState() {

      return {
        loaded: this.state.loaded,
        loading: this.state.loading,
        authenticated: this.state.authenticated,
        verified: this.state.verified,
        isAdmin: this.state.isAdmin,
        subscription: this.state.subscription,
        permissions: {
          ...this.state.permissions
        },
        error: this.state.error,
        checkedAt: this.state.checkedAt
      };

    },

    // ---------------------------------------------------
    // Permission check
    // ---------------------------------------------------

    can(permission) {

      if (!permission) {
        return false;
      }

      return (
        this.state.permissions[permission] === true
      );

    },

    // ---------------------------------------------------
    // Require permission
    // ---------------------------------------------------

    require(permission, options = {}) {

      const redirect =
        options.redirect !== false;

      const message =
        options.message ||
        "This feature requires additional account access.";

      if (this.can(permission)) {

        return true;

      }

      this.showLockedState(
        message,
        permission
      );

      if (redirect) {

        this.handleDeniedAccess(
          permission
        );

      }

      return false;

    },

    // ---------------------------------------------------
    // Page permissions
    // ---------------------------------------------------

    getPagePermission(page) {

      const pageMap = {

        "index.html":
          "platform",

        "markets.html":
          "markets",

        "terminal.html":
          "terminal",

        "analytics.html":
          "analytics",

        "ai.html":
          "ai",

        "bots.html":
          "bots",

        "settings.html":
          "platform",

        "subscription.html":
          "billing"

      };

      return pageMap[
        String(page).toLowerCase()
      ] || null;

    },

    // ---------------------------------------------------
    // Current page permission
    // ---------------------------------------------------

    async enforcePage() {

      if (!this.state.loaded) {

        await this.initialize();

      }

      const page =
        window.location.pathname
          .split("/")
          .filter(Boolean)
          .pop()
          ?.toLowerCase() ||
        "index.html";

      const permission =
        this.getPagePermission(page);

      /*
      ---------------------------------------------------
      Public pages do not require a permission check.
      ---------------------------------------------------
      */

      if (!permission) {
        return true;
      }

      /*
      ---------------------------------------------------
      Markets can remain publicly viewable.
      ---------------------------------------------------
      */

      if (
        page === "markets.html" &&
        this.can("markets")
      ) {

        return true;

      }

      /*
      ---------------------------------------------------
      Protected platform page.
      ---------------------------------------------------
      */

      if (this.can(permission)) {

        return true;

      }

      /*
      ---------------------------------------------------
      User isn't allowed to enter.
      ---------------------------------------------------
      */

      this.showLockedState(
        "This KINGBOT module is currently locked.",
        permission
      );

      return false;

    },

    // ---------------------------------------------------
    // Subscription helpers
    // ---------------------------------------------------

    hasSubscription() {

      return this.state.isAdmin === true || Boolean(
        this.state.subscription &&
        this.state.subscription.active === true
      );

    },

    getSubscriptionPlan() {

      if (this.state.isAdmin) {
        return "admin";
      }

      if (!this.state.subscription) {
        return null;
      }

      return (
        this.state.subscription.plan ||
        this.state.subscription.plan_id ||
        null
      );

    },

    scheduleExpiryRefresh() {

      if (this.state.expiryTimer) {
        clearTimeout(this.state.expiryTimer);
        this.state.expiryTimer = null;
      }

      const expiresAt = this.state.subscription?.expires_at;
      if (!expiresAt) return;

      const delay = Math.max(
        1000,
        new Date(expiresAt).getTime() - Date.now() + 1500
      );

      this.state.expiryTimer = setTimeout(async () => {
        this.state.expiryTimer = null;
        await this.refresh();
        window.dispatchEvent(
          new CustomEvent("kingbot:subscription-expired", {
            detail: this.getState()
          })
        );
      }, Math.min(delay, 2147483647));

    },

    // ---------------------------------------------------
    // Feature availability
    // ---------------------------------------------------

    isFeatureAvailable(feature) {

      /*
      Sensitive features require both authentication
      and explicit backend permission.
      */

      const sensitiveFeatures = [
        "terminal",
        "bots",
        "ai",
        "analytics",
        "broker",
        "trading",
        "withdrawals",
        "billing"
      ];

      if (
        sensitiveFeatures.includes(feature)
      ) {

        if (
          !this.state.authenticated ||
          !this.state.verified
        ) {

          return false;

        }

      }

      return this.can(feature);

    },

    // ---------------------------------------------------
    // Bot controls
    // ---------------------------------------------------

    canControlBots() {

      return (
        this.state.authenticated === true &&
        this.state.verified === true &&
        this.can("bots")
      );

    },

    // ---------------------------------------------------
    // Broker controls
    // ---------------------------------------------------

    canConnectBroker() {

      return (
        this.state.authenticated === true &&
        this.state.verified === true &&
        this.can("broker")
      );

    },

    // ---------------------------------------------------
    // Trading controls
    // ---------------------------------------------------

    canTrade() {

      return (
        this.state.authenticated === true &&
        this.state.verified === true &&
        this.can("trading")
      );

    },

    // ---------------------------------------------------
    // Withdrawal controls
    // ---------------------------------------------------

    canWithdraw() {

      return (
        this.state.authenticated === true &&
        this.state.verified === true &&
        this.can("withdrawals")
      );

    },

    // ---------------------------------------------------
    // Denied access
    // ---------------------------------------------------

    handleDeniedAccess(permission) {

      /*
      ---------------------------------------------------
      Don't perform automatic redirects for every denied
      feature.

      The navigation system will eventually decide the
      correct destination.
      ---------------------------------------------------
      */

      window.dispatchEvent(
        new CustomEvent(
          "kingbot:access-denied",
          {
            detail: {
              permission
            }
          }
        )
      );

    },

    // ---------------------------------------------------
    // Locked UI
    // ---------------------------------------------------

    showLockedState(
      message,
      permission
    ) {

      let overlay =
        document.getElementById(
          "kingbot-access-overlay"
        );

      if (!overlay) {

        overlay =
          document.createElement("div");

        overlay.id =
          "kingbot-access-overlay";

        overlay.innerHTML = `

          <div class="kingbot-access-card">

            <div class="kingbot-access-icon">
              🔐
            </div>

            <div class="kingbot-access-brand">
              KING<span>BOT</span>
            </div>

            <h2>
              Access Restricted
            </h2>

            <p
              id="kingbot-access-message"
            ></p>

            <div
              class="kingbot-access-feature"
              id="kingbot-access-feature"
            ></div>

            <button
              type="button"
              id="kingbot-access-close"
            >
              CONTINUE
            </button>

          </div>

        `;

        document.body.appendChild(
          overlay
        );

        this.injectStyles();

        const close =
          document.getElementById(
            "kingbot-access-close"
          );

        if (close) {

          close.addEventListener(
            "click",
            () => {

              overlay.remove();

            }
          );

        }

      }

      const messageElement =
        document.getElementById(
          "kingbot-access-message"
        );

      if (messageElement) {

        messageElement.textContent =
          message;

      }

      const featureElement =
        document.getElementById(
          "kingbot-access-feature"
        );

      if (featureElement) {

        featureElement.textContent =
          permission
            ? `Required access: ${permission}`
            : "";
      }

    },

    // ---------------------------------------------------
    // UI styles
    // ---------------------------------------------------

    injectStyles() {

      if (
        document.getElementById(
          "kingbot-access-style"
        )
      ) {

        return;

      }

      const style =
        document.createElement("style");

      style.id =
        "kingbot-access-style";

      style.textContent = `

        #kingbot-access-overlay {

          position: fixed;

          inset: 0;

          z-index: 999998;

          display: flex;

          align-items: center;

          justify-content: center;

          padding: 20px;

          background:
            rgba(1,4,12,.82);

          backdrop-filter:
            blur(18px);

        }

        .kingbot-access-card {

          width:
            min(430px, 100%);

          padding: 38px 30px;

          text-align: center;

          border:
            1px solid
            rgba(246,185,59,.35);

          border-radius: 24px;

          background:
            linear-gradient(
              145deg,
              rgba(10,18,40,.97),
              rgba(3,6,18,.99)
            );

          box-shadow:
            0 0 70px
            rgba(25,230,255,.08);

          color:
            #eef2ff;

          font-family:
            Inter,
            system-ui,
            sans-serif;

        }

        .kingbot-access-icon {

          font-size: 34px;

          margin-bottom: 18px;

        }

        .kingbot-access-brand {

          font-family:
            Orbitron,
            system-ui,
            sans-serif;

          font-size: 23px;

          font-weight: 900;

          letter-spacing: 3px;

          color:
            #f6b93b;

        }

        .kingbot-access-brand span {

          color:
            #eef2ff;

        }

        .kingbot-access-card h2 {

          margin:
            22px 0 10px;

          font-size: 20px;

        }

        .kingbot-access-card p {

          margin: 0 auto;

          max-width: 340px;

          line-height: 1.7;

          color:
            rgba(238,242,255,.68);

          font-size: 14px;

        }

        .kingbot-access-feature {

          margin-top: 16px;

          padding: 9px 12px;

          border-radius: 10px;

          background:
            rgba(25,230,255,.06);

          border:
            1px solid
            rgba(25,230,255,.14);

          color:
            rgba(238,242,255,.45);

          font-family:
            monospace;

          font-size: 11px;

        }

        #kingbot-access-close {

          margin-top: 24px;

          padding:
            12px 22px;

          border:
            1px solid
            rgba(246,185,59,.45);

          border-radius: 10px;

          background:
            rgba(246,185,59,.08);

          color:
            #f6b93b;

          font-weight: 800;

          cursor: pointer;

          transition:
            .2s ease;

        }

        #kingbot-access-close:hover {

          background:
            rgba(246,185,59,.16);

          box-shadow:
            0 0 25px
            rgba(246,185,59,.12);

        }

      `;

      document.head.appendChild(
        style
      );

    },

    // ---------------------------------------------------
    // Refresh permissions
    // ---------------------------------------------------

    async refresh() {

      this.state.loaded = false;

      this.state.subscription = null;

      this.state.permissions = {};

      if (this.state.expiryTimer) {
        clearTimeout(this.state.expiryTimer);
        this.state.expiryTimer = null;
      }

      return this.initialize();

    }

  };

  // -----------------------------------------------------
  // GLOBAL ACCESS
  // -----------------------------------------------------

  window.KINGBOT_ACCESS =
    ACCESS_CONTROL;

  // -----------------------------------------------------
  // Initialize after DOM
  // -----------------------------------------------------

  document.addEventListener(
    "DOMContentLoaded",
    async () => {

      await ACCESS_CONTROL.initialize();

      window.dispatchEvent(
        new CustomEvent(
          "kingbot:access-ready",
          {
            detail:
              ACCESS_CONTROL.getState()
          }
        )
      );

    }
  );

})(window);
