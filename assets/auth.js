/* Cinderella admin — WebAuthn client glue (Addendum 4).
 * Served static under the strict CSP (script-src 'self'); no inline scripts.
 * Depends on /assets/webauthn-browser.js exposing the SimpleWebAuthnBrowser global. */
(function () {
  'use strict';
  var W = window.SimpleWebAuthnBrowser;

  function csrf() {
    return document.body && document.body.dataset ? document.body.dataset.csrf || '' : '';
  }

  async function postJSON(url, body, withCsrf) {
    var headers = { 'content-type': 'application/json' };
    if (withCsrf) headers['x-csrf-token'] = csrf();
    var res = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body ? JSON.stringify(body) : '{}',
      credentials: 'same-origin',
    });
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    return { status: res.status, data: data };
  }

  function showStatus(id, msg) {
    var el = document.getElementById(id);
    if (!el) {
      alert(msg);
      return;
    }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // --- Passkey login ---
  var loginBtn = document.getElementById('passkey-login');
  if (loginBtn && W) {
    loginBtn.addEventListener('click', async function () {
      loginBtn.disabled = true;
      try {
        var opt = await postJSON('/webauthn/login/options', {}, false);
        if (opt.status !== 200) throw new Error(opt.data.error || 'could not start');
        var assertion = await W.startAuthentication({ optionsJSON: opt.data });
        var ver = await postJSON('/webauthn/login/verify', assertion, false);
        if (ver.status === 200 && ver.data.ok) {
          window.location.href = ver.data.redirect || '/';
          return;
        }
        throw new Error(ver.data.error || 'sign-in failed');
      } catch (e) {
        showStatus('passkey-status', e && e.message ? e.message : 'Passkey sign-in failed.');
        loginBtn.disabled = false;
      }
    });
  }

  // --- Register a new passkey (Security page) ---
  var regBtn = document.getElementById('register-passkey');
  if (regBtn && W) {
    regBtn.addEventListener('click', async function () {
      var nameInput = document.getElementById('passkey-name');
      var name = nameInput && nameInput.value ? nameInput.value : 'passkey';
      regBtn.disabled = true;
      try {
        var opt = await postJSON('/webauthn/register/options', { name: name }, true);
        if (opt.status !== 200) throw new Error(opt.data.error || 'could not start');
        var att = await W.startRegistration({ optionsJSON: opt.data });
        var ver = await postJSON('/webauthn/register/verify', { response: att, name: name }, true);
        if (ver.status === 200 && ver.data.ok) {
          window.location.reload();
          return;
        }
        throw new Error(ver.data.error || 'registration failed');
      } catch (e) {
        showStatus('security-status', e && e.message ? e.message : 'Passkey registration failed.');
        regBtn.disabled = false;
      }
    });
  }

  // --- Step-up before sensitive actions (data-stepup-required on <body>) ---
  async function stepUp() {
    var opt = await postJSON('/webauthn/stepup/options', {}, true);
    if (opt.status !== 200) throw new Error(opt.data.error || 'step-up unavailable');
    var assertion = await W.startAuthentication({ optionsJSON: opt.data });
    var ver = await postJSON('/webauthn/stepup/verify', assertion, true);
    if (ver.status !== 200 || !ver.data.ok) throw new Error(ver.data.error || 'step-up failed');
  }

  if (document.body && document.body.dataset && document.body.dataset.stepupRequired === '1' && W) {
    document.addEventListener(
      'submit',
      async function (ev) {
        var form = ev.target;
        if (!(form instanceof HTMLFormElement)) return;
        var action = form.getAttribute('action') || '';
        if (action === '/login' || action === '/logout' || action.indexOf('/webauthn/') === 0)
          return;
        if (form.dataset.stepupDone === '1') return; // already stepped up, allow submit
        ev.preventDefault();
        try {
          await stepUp();
          form.dataset.stepupDone = '1';
          form.submit();
        } catch (e) {
          alert((e && e.message ? e.message : 'Re-verification failed') + ' — action cancelled.');
        }
      },
      true,
    );
  }
})();
