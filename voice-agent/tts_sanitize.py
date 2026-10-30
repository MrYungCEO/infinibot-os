"""Voice-agent TTS sanitizer — strips code, paths, IDs, and markdown before Kokoro."""

import re

_FENCED_CODE = re.compile(r'```[^\n`]*\n?(.*?)```', re.DOTALL)
_INLINE_BACKTICK = re.compile(r'`([^`\n]+)`')
_URL = re.compile(r'https?://\S+')
_FILE_PATH = re.compile(r'(?<!\w)(?:~/[\w.\-/]+|(?:/[\w.\-]+){2,}[\w.\-/]*)')
_SLUG_ID = re.compile(r'\b[a-z0-9]{4,}(?:-[a-z0-9]{4,}){2,}\b')
_LONG_ID = re.compile(r'\b(?=[a-zA-Z0-9]*[a-zA-Z])(?=[a-zA-Z0-9]*[0-9])[a-zA-Z0-9]{16,}\b')
_HEADER = re.compile(r'^#{1,6}\s+', re.MULTILINE)
_HRULE = re.compile(r'^[-*_]{3,}\s*$', re.MULTILINE)
_BOLD = re.compile(r'\*\*(.+?)\*\*', re.DOTALL)
_ITALIC_STAR = re.compile(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', re.DOTALL)
_ITALIC_UNDER = re.compile(r'(?<![_\w])_(.+?)_(?![_\w])')
_BULLET = re.compile(r'^\s*[-*]\s+', re.MULTILINE)
_BLOCKQUOTE = re.compile(r'^>\s?', re.MULTILINE)
_MULTI_NEWLINE = re.compile(r'\n+')
_MULTI_SPACE = re.compile(r'[ \t]+')


def _classify_backtick(inner: str) -> str:
    s = inner.strip()
    if s.startswith(('http://', 'https://')):
        return 'the URL'
    if '/' in s:
        return 'the project file'
    if re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', s, re.I):
        return 'the identifier'
    if len(s) >= 8 and re.match(r'^[a-zA-Z0-9_\-]+$', s) and not s.isalpha():
        return 'the identifier'
    if s.isalpha() and len(s) <= 16:
        return s
    return 'the file'


def sanitize_for_tts(text: str, *, max_chars: int = 600) -> str:
    """Return a voice-friendly version of text with code/paths/IDs/markdown stripped."""
    if not text or not text.strip():
        return ''

    def _fenced_repl(m: re.Match) -> str:
        content = m.group(1).strip()
        return ' — code omitted — ' if len(content) > 20 else ' '

    text = _FENCED_CODE.sub(_fenced_repl, text)
    text = _INLINE_BACKTICK.sub(lambda m: _classify_backtick(m.group(1)), text)
    text = _URL.sub('(link)', text)

    def _path_repl(m: re.Match) -> str:
        p = m.group(0)
        if p.endswith('/') or not re.search(r'\.\w{1,6}$', p):
            return 'the project directory'
        return 'the project file'

    text = _FILE_PATH.sub(_path_repl, text)
    text = _SLUG_ID.sub('identifier', text)
    text = _LONG_ID.sub('identifier', text)
    text = _HEADER.sub('', text)
    text = _HRULE.sub('', text)
    text = _BOLD.sub(r'\1', text)
    text = _ITALIC_STAR.sub(r'\1', text)
    text = _ITALIC_UNDER.sub(r'\1', text)
    text = _BULLET.sub('', text)
    text = _BLOCKQUOTE.sub('', text)
    text = _MULTI_NEWLINE.sub(' ', text)
    text = _MULTI_SPACE.sub(' ', text)
    text = text.strip()

    if not text:
        return ''

    if len(text) > max_chars:
        truncated = text[:max_chars]
        cut = None
        for m in re.finditer(r'[.!?](?=[\s]|$)', truncated):
            cut = m.end()
        if cut is None:
            last_space = truncated.rfind(' ')
            cut = last_space if last_space > 0 else max_chars
        text = truncated[:cut].rstrip() + ' — more in chat.'

    return text
