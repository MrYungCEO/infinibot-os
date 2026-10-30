// Voice fast-path gate.
//
// Every voice turn currently runs the FULL embedded coding agent: the whole
// tool-schema set is serialized into the system prompt (huge prefill on the
// 128k-window local voice models) and the model may run a tool round-trip
// before it ever speaks. For a purely conversational turn ("hey", "how are
// you", "tell me a joke", "what's recursion") none of that is needed — a plain
// streaming chat completion answers instantly.
//
// This mirrors ROBOVOICE's tool-preflight bypass: dialogue streams straight to
// TTS; only turns that actually need tools pay the agent cost.
//
// SAFETY BIAS: we default to the full tool-capable path and only take the fast
// path when we're confident the utterance needs no tools. A false "fast" would
// make the model answer a data/action question from memory (wrong), so the gate
// errs toward keeping tools whenever there's any task/data/self-reference hint.

// Verbs and nouns that imply the model must DO something or fetch real data —
// any hit keeps the full tool-capable agent.
const TOOL_SIGNAL_RE = new RegExp(
  [
    // action verbs
    "\\b(open|launch|run|build|compile|deploy|ship|push|pull|commit|create|make|add|update|edit|change|modify|set|delete|remove|rename|move|fix|refactor|generate|render|draw|design|write|send|email|e-?mail|text|message|dm|call|ring|schedule|book|remind|spawn|start|stop|cancel|kill|restart|search|find|look\\s?up|check|show|pull\\s?up|list|read|summari[sz]e|analy[sz]e|translate|download|upload|save|export|import|attach|share|post|publish|assign|complete|close|reopen|navigate|go\\s?to|click|tap|scroll|select|filter|sort)\\b",
    // data / workspace nouns
    "\\b(project|projects|task|tasks|kanban|board|ticket|issue|revenue|invoice|payment|client|customer|calendar|schedule|meeting|appointment|email|inbox|message|file|files|folder|repo|repository|code|branch|pr|dashboard|note|notes|report|status|screen|screenshot|tab|window|vault|password|credential|contact|number|address|balance|budget|expense|order|shipment|inventory|metric|analytics|log|logs|database|server|deployment)\\b",
    // self / possessive reference to their data
    "\\b(my|our|mine|ours)\\b",
    // "what/when/where/how did I ..." — self-referential recall needs data
    "\\b(i|we)\\s+(did|do|does|have|had|need|want|owe|owed|made|make|sent|send|got|get|spent|spend|earn|earned|should|can|will|scheduled|schedule|created|create|added|add)\\b",
    // temporal recall ("what happened yesterday", "my day tomorrow") → data
    "\\b(yesterday|tomorrow|last\\s+week|this\\s+week|next\\s+week|last\\s+month|this\\s+month)\\b",
  ].join("|"),
  "i",
);

/**
 * Decide whether a voice utterance needs the full tool-capable agent, or can be
 * answered by a fast LLM-only streaming turn.
 *
 * Returns true (needs tools) whenever there is any task/data/self-reference
 * signal, the utterance is empty (nothing to classify safely), or it is long
 * enough that it's likely a real request rather than small talk.
 */
export function voiceTurnNeedsTools(rawMessage: string): boolean {
  const message = (rawMessage ?? "").trim();
  if (!message) return true; // no text (e.g. attachment-only) → play it safe

  if (TOOL_SIGNAL_RE.test(message)) return true;

  // Longer utterances without any signal are rare and usually still a request;
  // keep the safe path for anything beyond a short conversational sentence.
  const words = message.split(/\s+/).filter(Boolean);
  if (words.length > 18) return true;

  return false;
}
