/**
 * useResearch — Research Intelligence feed (same data as the web Research tab).
 *
 * The gateway exposes research over the colon-namespaced `research:*` RPCs
 * (src/gateway/server-methods/research.ts). The dot-named `research.list/get/
 * create/update/delete` document RPCs this hook used to call have no handler —
 * research *documents* are only reachable through the agent `research` tool.
 *
 *   research:status           -> { topics, watchlist, articles, settings, stats }
 *   research:article.read     { id } -> { success }   (toggles read)
 *   research:article.bookmark { id } -> { success }   (toggles bookmarked)
 */
import { useState, useCallback, useEffect } from 'react';

export function useResearch(gateway) {
  const sendReq = gateway?.sendReq;
  const [articles, setArticles] = useState([]);
  const [topics, setTopics] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!sendReq) return;
    setLoading(true);
    setError(null);
    try {
      const res = await sendReq('research:status', {});
      setArticles(Array.isArray(res?.articles) ? res.articles : []);
      setTopics(Array.isArray(res?.topics) ? res.topics : []);
      setStats(res?.stats || null);
      setLoaded(true);
    } catch (e) {
      setError(e?.message || 'Could not load research');
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  // Both article RPCs are toggles on the gateway, so flip locally and roll the
  // flip back if the call fails.
  const toggleFlag = useCallback(async (method, field, id) => {
    if (!sendReq || !id) return false;
    const flip = () =>
      setArticles((prev) => prev.map((a) => (a.id === id ? { ...a, [field]: !a[field] } : a)));
    flip();
    try {
      await sendReq(method, { id });
      return true;
    } catch (e) {
      flip();
      setError(e?.message || 'Could not update article');
      return false;
    }
  }, [sendReq]);

  const toggleRead = useCallback(
    (id) => toggleFlag('research:article.read', 'read', id),
    [toggleFlag],
  );
  const toggleBookmark = useCallback(
    (id) => toggleFlag('research:article.bookmark', 'bookmarked', id),
    [toggleFlag],
  );

  useEffect(() => {
    load();
  }, [load]);

  return {
    articles,
    topics,
    stats,
    loading,
    loaded,
    error,
    load,
    toggleRead,
    toggleBookmark,
    clearError: () => setError(null),
  };
}
