/*
=========================================================
 KINGBOT FINTECH — SESSION MANAGER
 GIBSONFX TECH
=========================================================

Purpose:
- Central session management
- Works with future real backend authentication
- No fake users
- No fake authentication
- No passwords stored in browser
- Uses server-side session when backend is available
- Gracefully reports "not authenticated" before backend exists

Expected backend endpoints:

GET  /api/auth/session
POST /api/auth/logout

Expected session response:

{
  "authenticated": true,
  "user": {
    "id": "...",
    "email": "...",
    "name": "...",
    "verified": true
  }
}

=========================================================
*/

(function (window) {
  "use strict";

  const KINGBOT_SESSION = {

    // ---------------------------------------------------
    // Configuration
    // ---------------------------------------------------

    config: {
      sessionEndpoint: "/api/auth/session",
      logoutEndpoint: "/api/auth/logout",

      // How long cached session information remains usable
      // before another server check is performed.
      cacheDuration: 30 * 1000,

      // Prevent accidental infinite redirects.
      maxRedirectAttempts: 1
    },

    // ---------------------------------------------------
    // Internal state
    // ---------------------------------------------------

    state: {
      checked: false,
      checking: false,
      authenticated: false,
      user: null,
      error: null,
      checkedAt: 0
    },

    // ---------------------------------------------------
    // Utility
    // ---------------------------------------------------

    isAuthPage() {
      const path = window.location.pathname.toLowerCase();

      return (
        path.endsWith("/signin.html") ||
        path.endsWith("/signup.html") ||
        path.endsWith("/verify.html") ||
        path.endsWith("/verification.html")
      );
    },

    isLoaderPage() {
      return window.location.pathname.toLowerCase().includes(
        "/system/loader.html"
      );
    },

    getCurrentPage() {
      const path = window.location.pathname;

      const parts = path.split("/").filter(Boolean);

      return parts.length
        ? parts[parts.length - 1]
        : "index.html";
    },

    getReturnUrl() {
      return window.location.pathname + window.location.search;
    },

    // ---------------------------------------------------
    // Server session check
    // ---------------------------------------------------

    async check(options = {}) {

      const force = Boolean(options.force);

      if (
        !force &&
        this.state.checked &&
        Date.now() - this.state.checkedAt <
          this.config.cacheDuration
      ) {
        return this.getState();
      }

      if (this.state.checking) {
        return new Promise((resolve) => {

          const wait = setInterval(() => {

            if (!this.state.checking) {
              clearInterval(wait);
              resolve(this.getState());
            }

          }, 50);

        });
      }

      this.state.checking = true;
      this.state.error = null;

      try {

        const response = await fetch(
          this.config.sessionEndpoint,
          {
            method: "GET",

            credentials: "include",

            headers: {
              "Accept": "application/json",
              "Cache-Control": "no-cache"
            },

            cache: "no-store"
          }
        );

        /*
        ---------------------------------------------------
        401 / 403 = not authenticated
        ---------------------------------------------------
        This is NOT treated as a system failure.
        ---------------------------------------------------
        */

        if (
          response.status === 401 ||
          response.status === 403
        ) {

          this.state.authenticated = false;
          this.state.user = null;
          this.state.checked = true;
          this.state.checkedAt = Date.now();

          return this.getState();
        }

        /*
        ---------------------------------------------------
        Other HTTP errors
        ---------------------------------------------------
        */

        if (!response.ok) {

          throw new Error(
            `Session request failed: HTTP ${response.status}`
          );

        }

        const data = await response.json();

        /*
        ---------------------------------------------------
        Validate response
        ---------------------------------------------------
        */

        if (data && data.authenticated === true) {

          this.state.authenticated = true;

          this.state.user = data.user || null;

        } else {

          this.state.authenticated = false;
          this.state.user = null;

        }

        this.state.checked = true;
        this.state.checkedAt = Date.now();

        return this.getState();

      } catch (error) {

        console.error(
          "[KINGBOT SESSION] Session check failed:",
          error
        );

        this.state.error = error;
        this.state.checked = true;
        this.state.checkedAt = Date.now();

        /*
        ---------------------------------------------------
        IMPORTANT SECURITY BEHAVIOR
        ---------------------------------------------------

        If the authentication server cannot be reached,
        we do NOT assume the user is authenticated.

        ---------------------------------------------------
        */

        this.state.authenticated = false;
        this.state.user = null;

        return this.getState();

      } finally {

        this.state.checking = false;

      }
    },

    // ---------------------------------------------------
    // Current state
    // ---------------------------------------------------

    getState() {

      return {
        checked: this.state.checked,
        checking: this.state.checking,
        authenticated: this.state.authenticated,
        user: this.state.user,
        error: this.state.error,
        checkedAt: this.state.checkedAt
      };

    },

    // ---------------------------------------------------
    // Authentication status
    // ---------------------------------------------------

    isAuthenticated() {
      return this.state.authenticated === true;
    },

    isVerified() {

      return (
        this.isAuthenticated() &&
        this.state.user &&
        this.state.user.verified === true
      );

    },

    getUser() {
      return this.state.user;
    },

    // ---------------------------------------------------
    // Require authentication
    // ---------------------------------------------------

    async requireAuth(options = {}) {

      const redirect = options.redirect !== false;

      const state = await this.check();

      if (state.authenticated) {
        return true;
      }

      if (
        redirect &&
        !this.isAuthPage() &&
        !this.isLoaderPage()
      ) {

        this.redirectToSignIn();

      }

      return false;
    },

    // ---------------------------------------------------
    // Require verified account
    // ---------------------------------------------------

    async requireVerified(options = {}) {

      const redirect = options.redirect !== false;

      const authenticated = await this.requireAuth({
        redirect
      });

      if (!authenticated) {
        return false;
      }

      if (this.isVerified()) {
        return true;
      }

      if (redirect) {

        window.location.href =
          "verify.html?return=" +
          encodeURIComponent(this.getReturnUrl());

      }

      return false;
    },

    // ---------------------------------------------------
    // Redirect to sign in
    // ---------------------------------------------------

    redirectToSignIn() {

      const returnUrl = this.getReturnUrl();

      let destination = "signin.html";

      if (returnUrl) {

        destination +=
          "?return=" +
          encodeURIComponent(returnUrl);

      }

      window.location.replace(destination);

    },

    // ---------------------------------------------------
    // Redirect after login
    // ---------------------------------------------------

    redirectAfterLogin() {

      const params =
        new URLSearchParams(window.location.search);

      const returnUrl =
        params.get("return");

      /*
      ---------------------------------------------------
      Security:
      Only allow local relative URLs.

      We never redirect to:
      https://...
      javascript:...
      //external-site...
      ---------------------------------------------------
      */

      if (
        returnUrl &&
        returnUrl.startsWith("/") &&
        !returnUrl.startsWith("//") &&
        !returnUrl.toLowerCase().startsWith("/signin") &&
        !returnUrl.toLowerCase().startsWith("/signup")
      ) {

        window.location.replace(returnUrl);
        return;

      }

      window.location.replace("index.html");

    },

    // ---------------------------------------------------
    // Logout
    // ---------------------------------------------------

    async logout(options = {}) {

      const redirect =
        options.redirect !== false;

      try {

        const response = await fetch(
          this.config.logoutEndpoint,
          {
            method: "POST",

            credentials: "include",

            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json"
            },

            cache: "no-store"
          }
        );

        /*
        ---------------------------------------------------
        Even if the server reports an error, locally we
        clear our session state.
        ---------------------------------------------------
        */

        if (!response.ok) {

          console.warn(
            "[KINGBOT SESSION] Logout response:",
            response.status
          );

        }

      } catch (error) {

        console.error(
          "[KINGBOT SESSION] Logout request failed:",
          error
        );

      } finally {

        this.clear();

        if (redirect) {

          window.location.replace(
            "signin.html"
          );

        }

      }

    },

    // ---------------------------------------------------
    // Clear local state
    // ---------------------------------------------------

    clear() {

      this.state = {
        checked: true,
        checking: false,
        authenticated: false,
        user: null,
        error: null,
        checkedAt: Date.now()
      };

    },

    // ---------------------------------------------------
    // User display helpers
    // ---------------------------------------------------

    getDisplayName() {

      if (!this.state.user) {
        return "Guest";
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
        return "";
      }

      return this.state.user.email || "";

    },

    getUserId() {

      if (!this.state.user) {
        return "";
      }

      return this.state.user.id || "";

    },

    // ---------------------------------------------------
    // Update user interface
    // ---------------------------------------------------

    updateUserElements() {

      const user = this.state.user;

      /*
      Supported HTML attributes:

      data-kingbot-user
      data-kingbot-email
      data-kingbot-id
      data-kingbot-auth-status
      */

      document
        .querySelectorAll("[data-kingbot-user]")
        .forEach((element) => {

          element.textContent =
            this.getDisplayName();

        });

      document
        .querySelectorAll("[data-kingbot-email]")
        .forEach((element) => {

          element.textContent =
            this.getEmail();

        });

      document
        .querySelectorAll("[data-kingbot-id]")
        .forEach((element) => {

          element.textContent =
            this.getUserId();

        });

      document
        .querySelectorAll("[data-kingbot-auth-status]")
        .forEach((element) => {

          element.textContent =
            this.isAuthenticated()
              ? "Authenticated"
              : "Not Authenticated";

        });

    },

    // ---------------------------------------------------
    // Listen for authentication changes
    // ---------------------------------------------------

    emitChange() {

      window.dispatchEvent(
        new CustomEvent(
          "kingbot:session-change",
          {
            detail: this.getState()
          }
        )
      );

    },

    // ---------------------------------------------------
    // Refresh session
    // ---------------------------------------------------

    async refresh() {

      const state =
        await this.check({
          force: true
        });

      this.updateUserElements();
      this.emitChange();

      return state;

    }

  };

  // -----------------------------------------------------
  // Expose globally
  // -----------------------------------------------------

  window.KINGBOT_SESSION =
    KINGBOT_SESSION;

  // -----------------------------------------------------
  // Automatic initialization
  // -----------------------------------------------------

  document.addEventListener(
    "DOMContentLoaded",
    async () => {

      await KINGBOT_SESSION.check();

      KINGBOT_SESSION.updateUserElements();

      KINGBOT_SESSION.emitChange();

    }
  );

})(window);
