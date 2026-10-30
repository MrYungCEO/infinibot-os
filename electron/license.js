// Open-source build stub: the real module is part of the hosted product (see LICENSING.md).
// A build from this repository is always self-hosted: no sign-in, no plan gating.
'use strict';
const KV_BASE = '';
const STATE = Object.freeze({ plan: 'self-hosted', features: {}, token: null, selfHosted: true });
const noop = async () => STATE;
module.exports = {
  KV_BASE,
  isSelfHosted: () => true,
  init: noop,
  loadLicense: () => STATE,
  saveLicense: () => {},
  getPlan: () => STATE.plan,
  getFeatures: () => STATE.features,
  getToken: () => null,
  hasFeature: () => true,
  planAtLeast: () => true,
  getState: () => STATE,
  setGuestLicense: noop,
  setDebugLicense: noop,
  logout: noop,
  refreshLicense: noop,
  verifyToken: () => null,
};
