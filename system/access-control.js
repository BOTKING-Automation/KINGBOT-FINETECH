/*
=========================================================
 KINGBOT FINTECH — ACCESS CONTROL
 GIBSONFX TECH
=========================================================
*/

(function (window) {
  "use strict";

  const ACCESS_CONTROL = {
    config: {
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
      permissionsEndpoint: "/subscription/me"
    },

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

    async initialize() {
      if (this.state.loading) return this.getState();
      this.state.loading = true;
      this.state.error = null;
      try {
        if (!window.KINGBOT_SESSION) throw new Error("KINGBOT_SESSION is not available.");
        const session = await window.KINGBOT_SESSION.check();
        this.state.authenticated = session.authenticated === true;
        this.state.isAdmin = false;
        this.state.verified = Boolean(session.user && session.user.verified === true);

        if (!this.state.authenticated) {
          this.state.permissions = { ...this.config.defaultPermissions, markets: true };
          this.state.loaded = true;
          this.state.checkedAt = Date.now();
          return this.getState();
        }

        const response = await window.KINGBOT_API.request(this.config.permissionsEndpoint, {
          method: "GET",
          headers: { "Cache-Control": "no-cache" }
        });

        if (response.status === 404 || response.status === 401 || response.status === 403) {
          this.state.permissions = { ...this.config.defaultPermissions, markets: true };
          this.state.loaded = true;
          this.state.checkedAt = Date.now();
          return this.getState();
        }

        if (!response.ok) throw new Error("Permission request failed: HTTP " + response.status);

        const data = await response.json();
        const administrator = data.isAdmin === true;
        this.state.isAdmin = administrator;
        this.state.permissions = {
          ...this.config.defaultPermissions,
          ...(() => {
            const active = Boolean(data.subscription);
            const pro = ["pro", "institutional"].includes(String(data.subscription?.plan_id || ""));
            const entitlements = Array.isArray(data.entitlements) ? data.entitlements : [];
            return administrator
              ? { platform: true, markets: true, terminal: true, analytics: true, ai: true, bots: true, broker: true, trading: true, withdrawals: false, billing: true, admin: true }
              : { platform: true, markets: true, terminal: active, analytics: active, ai: active && pro, bots: active && entitlements.length > 0, broker: active, trading: active, withdrawals: false, billing: true, admin: false };
          })()
        };
        this.state.subscription = data.subscription
          ? { ...data.subscription, active: true, plan: data.subscription.plan_id }
          : null;
        this.scheduleExpiryRefresh();
        this.state.loaded = true;
        this.state.checkedAt = Date.now();
        return this.getState();
      } catch (error) {
        console.error("[KINGBOT ACCESS] Permission check failed:", error);
        this.state.error = error;
        this.state.permissions = { ...this.config.defaultPermissions, markets: true };
        this.state.loaded = true;
        this.state.checkedAt = Date.now();
        return this.getState();
      } finally {
        this.state.loading = false;
      }
    },

    getState() {
      return {
        loaded: this.state.loaded,
        loading: this.state.loading,
        authenticated: this.state.authenticated,
        verified: this.state.verified,
        isAdmin: this.state.isAdmin,
        subscription: this.state.subscription,
        permissions: { ...this.state.permissions },
        error: this.state.error,
        checkedAt: this.state.checkedAt
      };
    },

    can(permission) {
      if (!permission) return false;
      return this.state.permissions[permission] === true;
    },

    require(permission, options = {}) {
      const redirect = options.redirect !== false;
      const message = options.message || "This feature requires additional account access.";
      if (this.can(permission)) return true;
      this.showLockedState(message, permission);
      if (redirect) this.handleDeniedAccess(permission);
      return false;
    },

    getPagePermission(page) {
      const pageMap = {
        "index.html": "platform",
        "markets.html": "markets",
        "terminal.html": "terminal",
        "analytics.html": "analytics",
        "ai.html": "ai",
        "scanner.html": "ai",
        "bots.html": "bots",
        "broker-connect.html": "broker",
        "settings.html": "platform",
        "subscription.html": "billing",
        "partner-revenue.html": "admin"
      };
      return pageMap[String(page).toLowerCase()] || null;
    },

    async enforcePage() {
      if (!this.state.loaded) await this.initialize();
      const page = window.location.pathname.split("/").filter(Boolean).pop()?.toLowerCase() || "index.html";
      const permission = this.getPagePermission(page);
      if (!permission) return true;
      if (page === "markets.html" && this.can("markets")) return true;
      if (this.can(permission)) return true;
      this.showLockedState("This KINGBOT module is currently locked.", permission);
      return false;
    },

    hasSubscription() {
      return this.state.isAdmin === true || Boolean(this.state.subscription && this.state.subscription.active === true);
    },

    getSubscriptionPlan() {
      if (this.state.isAdmin) return "admin";
      if (!this.state.subscription) return null;
      return this.state.subscription.plan || this.state.subscription.plan_id || null;
    },

    scheduleExpiryRefresh() {
      if (this.state.expiryTimer) {
        clearTimeout(this.state.expiryTimer);
        this.state.expiryTimer = null;
      }
      const expiresAt = this.state.subscription?.expires_at;
      if (!expiresAt) return;
      const delay = Math.max(1000, new Date(expiresAt).getTime() - Date.now() + 1500);
      this.state.expiryTimer = setTimeout(async () => {
        this.state.expiryTimer = null;
        await this.refresh();
        window.dispatchEvent(new CustomEvent("kingbot:subscription-expired", { detail: this.getState() }));
      }, Math.min(delay, 2147483647));
    },

    isFeatureAvailable(feature) {
      const sensitive = ["terminal", "bots", "ai", "analytics", "broker", "trading", "withdrawals", "billing"];
      if (sensitive.includes(feature) && (!this.state.authenticated || !this.state.verified)) return false;
      return this.can(feature);
    },

    canControlBots() {
      return this.state.authenticated === true && this.state.verified === true && this.can("bots");
    },

    canConnectBroker() {
      return this.state.authenticated === true && this.state.verified === true && this.can("broker");
    },

    canTrade() {
      return this.state.authenticated === true && this.state.verified === true && this.can("trading");
    },

    canWithdraw() {
      return this.state.authenticated === true && this.state.verified === true && this.can("withdrawals");
    },

    handleDeniedAccess(permission) {
      window.dispatchEvent(new CustomEvent("kingbot:access-denied", { detail: { permission } }));
    },

    showLockedState(message, permission) {
      let overlay = document.getElementById("kingbot-access-overlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "kingbot-access-overlay";
        overlay.innerHTML = '<div style="position:fixed;inset:0;z-index:999998;display:flex;align-items:center;justify-content:center;background:rgba(1,4,12,.82);backdrop-filter:blur(12px)"><div style="max-width:420px;padding:32px;border-radius:20px;border:1px solid rgba(246,185,59,.35);background:#0a1228;color:#eef2ff;text-align:center;font-family:Inter,sans-serif"><h2>Access Restricted</h2><p id="kingbot-access-message"></p><div id="kingbot-access-feature" style="opacity:.7;margin:12px 0"></div><button type="button" id="kingbot-access-close" style="padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#fff;cursor:pointer">CONTINUE</button></div></div>';
        document.body.appendChild(overlay);
        document.getElementById("kingbot-access-close")?.addEventListener("click", () => overlay.remove());
      }
      const msg = document.getElementById("kingbot-access-message");
      if (msg) msg.textContent = message;
      const feat = document.getElementById("kingbot-access-feature");
      if (feat) feat.textContent = permission ? "Required access: " + permission : "";
    },

    async refresh() {
      this.state.loaded = false;
      return this.initialize();
    }
  };

  window.KINGBOT_ACCESS = ACCESS_CONTROL;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ACCESS_CONTROL.initialize().catch(() => {}), { once: true });
  } else {
    ACCESS_CONTROL.initialize().catch(() => {});
  }
})(window);
