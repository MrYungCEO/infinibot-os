// useCampaigns — talks to the in-flight `campaigns.*` gateway methods
// (added by a sibling agent). The screen calls this hook on mount; if the
// method set isn't deployed yet we surface `supported=false` so the screen
// can render a "Coming soon" affordance instead of erroring out.

import { useCallback, useEffect, useState } from 'react';

const NOT_FOUND_PATTERNS = [
  /method not found/i,
  /unknown method/i,
  /not implemented/i,
  /no handler/i,
  /unsupported method/i,
];

function looksLikeMissingMethod(err) {
  if (!err) return false;
  const msg = String(err?.message || err);
  return NOT_FOUND_PATTERNS.some((rx) => rx.test(msg));
}

export function useCampaigns(gateway) {
  const { sendReq, status } = gateway || {};
  const [campaigns, setCampaigns] = useState([]);
  const [supported, setSupported] = useState(null); // null=unknown, true|false
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!sendReq || status !== 'connected') return;
    setLoading(true);
    setError(null);
    try {
      const res = await sendReq('campaigns.list', {});
      const list = Array.isArray(res?.campaigns) ? res.campaigns : Array.isArray(res) ? res : [];
      setCampaigns(list);
      setSupported(true);
    } catch (err) {
      if (looksLikeMissingMethod(err)) {
        setSupported(false);
        setError(null);
      } else {
        setError(err?.message || String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [sendReq, status]);

  useEffect(() => {
    if (status === 'connected') load();
  }, [status, load]);

  const create = useCallback(
    async (input) => {
      if (!sendReq) return null;
      try {
        const res = await sendReq('campaigns.create', input);
        await load();
        return res;
      } catch (err) {
        if (looksLikeMissingMethod(err)) setSupported(false);
        throw err;
      }
    },
    [sendReq, load],
  );

  const update = useCallback(
    async (id, patch) => {
      if (!sendReq) return null;
      try {
        const res = await sendReq('campaigns.update', { id, ...patch });
        await load();
        return res;
      } catch (err) {
        if (looksLikeMissingMethod(err)) setSupported(false);
        throw err;
      }
    },
    [sendReq, load],
  );

  const remove = useCallback(
    async (id) => {
      if (!sendReq) return null;
      try {
        const res = await sendReq('campaigns.delete', { id });
        await load();
        return res;
      } catch (err) {
        if (looksLikeMissingMethod(err)) setSupported(false);
        throw err;
      }
    },
    [sendReq, load],
  );

  return { campaigns, supported, loading, error, refresh: load, create, update, remove };
}
