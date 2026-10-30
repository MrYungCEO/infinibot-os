"""Pytest tests for tts_sanitize.sanitize_for_tts."""

import pytest
from tts_sanitize import sanitize_for_tts


def test_fenced_code_block_nontrivial():
    text = "Here is the code:\n```python\ndef hello():\n    print('Hello, world!')\n```\nUse it wisely."
    result = sanitize_for_tts(text)
    assert '— code omitted —' in result
    assert 'def hello' not in result
    assert 'Use it wisely' in result


def test_fenced_code_block_trivial_removed_silently():
    text = "Use ```x``` here."
    result = sanitize_for_tts(text)
    assert '```' not in result
    assert '— code omitted —' not in result
    assert 'Use' in result
    assert 'here' in result


def test_inline_backtick_simple_word_kept():
    text = "Update the `config` setting."
    result = sanitize_for_tts(text)
    assert 'config' in result
    assert '`' not in result


def test_inline_backtick_path_to_project_file():
    text = "Check `src/lib/clerkAppearance.ts` for details."
    result = sanitize_for_tts(text)
    assert '`' not in result
    assert 'src/lib' not in result
    assert 'the project file' in result


def test_inline_backtick_absolute_path_to_project_file():
    text = "Check `/home/user/Desktop/foo/bar.ts` for the fix"
    result = sanitize_for_tts(text)
    assert 'the project file' in result
    assert '/home/user' not in result
    assert '`' not in result


def test_inline_backtick_uuid_to_identifier():
    text = "Session `550e8400-e29b-41d4-a716-446655440000` expired."
    result = sanitize_for_tts(text)
    assert 'the identifier' in result
    assert '550e8400' not in result


def test_inline_backtick_run_id_to_identifier():
    text = "Run ID: `coder-glassmorphism-sign-modal-kingly-vault-oxox`"
    result = sanitize_for_tts(text)
    assert 'the identifier' in result
    assert 'glassmorphism' not in result
    assert '`' not in result


def test_url_collapse():
    text = "Visit https://example.com/api/v1/users for the API docs."
    result = sanitize_for_tts(text)
    assert 'https://' not in result
    assert '(link)' in result
    assert 'for the API docs' in result


def test_long_id_collapse():
    text = "Commit deadbeef12345678cafebabe90abcdef was deployed."
    result = sanitize_for_tts(text)
    assert 'deadbeef12345678cafebabe90abcdef' not in result
    assert 'identifier' in result


def test_bare_slug_id_collapse():
    text = "Session coder-glassmorphism-sign-modal-kingly-vault-oxox completed."
    result = sanitize_for_tts(text)
    assert 'glassmorphism' not in result
    assert 'identifier' in result
    assert 'completed' in result


def test_markdown_header_stripping():
    text = "## Installation\nRun the command to install the package."
    result = sanitize_for_tts(text)
    assert '##' not in result
    assert 'Installation' in result
    assert 'Run the command' in result


def test_bold_and_bullet_stripping():
    text = "**Important:** Steps:\n- Step one here\n* Step two here"
    result = sanitize_for_tts(text)
    assert '**' not in result
    assert 'Important' in result
    assert 'Step one here' in result
    assert 'Step two here' in result


def test_blockquote_stripped():
    text = "> This is a quoted line\n> And another one"
    result = sanitize_for_tts(text)
    assert '>' not in result
    assert 'quoted line' in result
    assert 'another one' in result


def test_length_cap_with_sentence_truncation():
    base = "This is a full sentence. "
    text = base * 30  # 750 chars
    result = sanitize_for_tts(text, max_chars=100)
    assert '— more in chat.' in result
    assert len(result) <= 100 + len(' — more in chat.')


def test_empty_input_returns_empty():
    assert sanitize_for_tts('') == ''
    assert sanitize_for_tts('   ') == ''
    assert sanitize_for_tts('\n\n\t  \n') == ''


def test_absolute_file_path_bare():
    text = "The file /home/user/Desktop/Development/InfiniBot-fresh/src/agent.ts was changed."
    result = sanitize_for_tts(text)
    assert '/home/user' not in result
    assert 'the project file' in result
    assert 'was changed' in result


def test_clean_text_passes_through():
    text = "The build finished successfully. All tests passed."
    result = sanitize_for_tts(text)
    assert result == text
