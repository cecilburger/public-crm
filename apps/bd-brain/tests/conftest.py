"""Keep the suite off the network and out of the developer's own settings.

`Settings()` reads its defaults from os.environ, so ANY environment variable
that belongs to a real deployment silently changes what the tests exercise.
The one that costs money is ANTHROPIC_API_KEY: with it set, every test that
builds a bare `Settings()` runs with live generation, so the suite calls the
API for real. Measured on 18 Sep 2026, when a new test called `config.load()`
(which does os.environ.setdefault() for every line of the real .env): 16
tests failed because they expect static templates, and the run went from
36 seconds to 8 minutes 24 — of billable calls.

Nothing in tests/ is supposed to reach Anthropic; the generation paths are
covered with fakes. So the variables are cleared for the whole session, once,
rather than trusted not to be there.
"""

import os

import pytest

#: Cleared for every test. Each one flips real behaviour on: the first two
#: turn on generation, and the key is what makes it billable.
_LIVE_ENV = ("ANTHROPIC_API_KEY", "USE_LLM_REPLIES", "USE_LLM_INTENTS")


@pytest.fixture(autouse=True, scope="session")
def _no_live_api():
    saved = {k: os.environ.pop(k, None) for k in _LIVE_ENV}
    yield
    for k, v in saved.items():
        if v is not None:
            os.environ[k] = v
