"""URL, HTML and CSS rewriting for the HA Browser proxy.

Proxied URL layout:  {prefix}/{scheme}/{host[:port]}/{path}?{query}
Only root-relative, protocol-relative and absolute URLs need rewriting;
path-relative URLs keep working because the path layout mirrors the origin.
Dynamic URLs created by page JavaScript are handled by shim.js.
"""
from __future__ import annotations

import json
import re
from urllib.parse import SplitResult, urljoin, urlsplit

_SKIP = re.compile(r"^(?:data|blob|javascript|about|mailto|tel|sms|file|chrome|view-source):", re.I)
_HAS_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")

URL_ATTRS = frozenset(
    {
        "href", "src", "action", "poster", "formaction", "background", "cite",
        "longdesc", "manifest", "data", "data-src", "data-href", "data-url",
        "xlink:href",
    }
)

_TAG_RE = re.compile(r"<[a-zA-Z][^\s/>]*(?:\"[^\"]*\"|'[^']*'|[^'\">])*>")
_ATTR_RE = re.compile(
    r"""(?<![\w:.\-])(?P<name>[a-zA-Z_:][\w:.\-]*)(?P<eq>\s*=\s*)"""
    r"""(?:"(?P<dq>[^"]*)"|'(?P<sq>[^']*)'|(?P<uq>[^\s"'=<>`]+))"""
)
_CHUNK_RE = re.compile(
    r"(?P<script><script\b(?:\"[^\"]*\"|'[^']*'|[^'\">])*>)(?P<body>.*?)(?P<close></script\s*>)"
    r"|(?P<tag><[a-zA-Z][^\s/>]*(?:\"[^\"]*\"|'[^']*'|[^'\">])*>)",
    re.I | re.S,
)
_TYPE_ATTR = re.compile(r"""(?<![\w-])type\s*=\s*["']?([^"'\s>]*)""", re.I)
_STYLE_RE = re.compile(r"(<style\b[^>]*>)(.*?)(</style>)", re.I | re.S)
_CSS_URL = re.compile(r"""url\(\s*(?P<q>["']?)(?P<u>[^"')]*?)(?P=q)\s*\)""", re.I)
_CSS_IMPORT = re.compile(r"""@import\s+(?P<q>["'])(?P<u>[^"']+)(?P=q)""", re.I)
_SRCSET = re.compile(r"(^|,)(\s*)([^\s,]+)")
_REFRESH = re.compile(r"^(\s*\d+\s*;\s*url\s*=\s*)(.+)$", re.I)
_BASE_TAG = re.compile(r"<base\b[^>]*>", re.I)
_BASE_HREF = re.compile(r"""href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.I)
_CSP_META = re.compile(
    r"""<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy[^>]*>""", re.I
)
_HEAD_OPEN = re.compile(r"<head(?:\s[^>]*)?>", re.I)
_HTML_OPEN = re.compile(r"<html(?:\s[^>]*)?>", re.I)
_DOCTYPE = re.compile(r"^\s*<!doctype[^>]*>", re.I)


def _is_js(open_tag: str) -> bool:
    m = _TYPE_ATTR.search(open_tag)
    if not m or not m[1]:
        return True
    t = m[1].lower()
    return t == "module" or "javascript" in t or "ecmascript" in t


def _guarded(repl):
    """Only substitute when the match is not the tail of a longer identifier."""

    def f(m):
        s, i = m.string, m.start()
        if i and (s[i - 1].isalnum() or s[i - 1] in "_$."):
            return m.group(0)
        return repl(m) if callable(repl) else repl

    return f


def _guarded_bare(m):
    s, i = m.string, m.start()
    if i and (s[i - 1].isalnum() or s[i - 1] in "_$.\"'`/\\-"):
        return m.group(0)
    return "__hb$loc"


# JS rewriting: make `location` report the real URL and defeat frame-busters.
_J_WINTOP = re.compile(r"(?:window|self|globalThis)\.top(?![\w$])")
_J_TOPLOC = re.compile(r"top\.location(?![\w$])")
_J_CMP_A = re.compile(r"top(\s*[!=]==?\s*)(self|window)(?![\w$])")
_J_CMP_B = re.compile(r"((?:window\.)?(?:self|window))(\s*[!=]==?\s*)top(?![\w$:])")
_J_LOCQ = re.compile(r"(?:window|self|globalThis|document|parent)\s*\.\s*location(?![\w$])")
_J_LOCBARE = re.compile(
    r"location(?=\s*(?:\.\s*(?:href|origin|protocol|host|hostname|port|pathname|search|hash"
    r"|assign|replace|reload|toString)(?![\w$])|=(?!=)|[,;)]))"
)


def to_proxy_url(prefix: str, parts: SplitResult) -> str:
    """Build the proxied path for an absolute http(s) URL."""
    netloc = parts.netloc.rpartition("@")[2]
    out = f"{prefix}/{parts.scheme}/{netloc}{parts.path or '/'}"
    if parts.query:
        out += "?" + parts.query
    if parts.fragment:
        out += "#" + parts.fragment
    return out


def build_shim_tag(shim_js: str, prefix: str, url: str, base: str) -> str:
    """Inline <script> carrying the client-side shim and its config."""
    cfg = json.dumps({"prefix": prefix, "url": url, "base": base}).replace("</", "<\\/")
    return f"<script>{shim_js}({cfg});</script>"


class Rewriter:
    """Rewrites content fetched from `base` so it works under `prefix`."""

    def __init__(self, prefix: str, base: str) -> None:
        self.prefix = prefix
        self.base = base
        self.force_abs = False

    # -- single URL ---------------------------------------------------
    def proxify(self, value: str) -> str:
        v = value.strip()
        if (
            not v
            or v.startswith("#")
            or "\\" in v  # escaped quotes etc. from JS strings: not a real URL
            or _SKIP.match(v)
            or v.startswith(self.prefix + "/")
        ):
            return value
        if self.force_abs or v.startswith("/") or _HAS_SCHEME.match(v):
            try:
                parts = urlsplit(urljoin(self.base, v))
            except ValueError:
                return value
            if parts.scheme in ("http", "https") and parts.hostname:
                return to_proxy_url(self.prefix, parts)
        return value

    # -- CSS ----------------------------------------------------------
    def css(self, text: str) -> str:
        text = _CSS_URL.sub(
            lambda m: f"url({m['q']}{self.proxify(m['u'])}{m['q']})", text
        )
        return _CSS_IMPORT.sub(
            lambda m: f"@import {m['q']}{self.proxify(m['u'])}{m['q']}", text
        )

    def srcset(self, value: str) -> str:
        return _SRCSET.sub(
            lambda m: f"{m[1]}{m[2]}{self.proxify(m[3])}", value
        )

    # -- JavaScript ---------------------------------------------------
    def js(self, code: str) -> str:
        if "top" in code:
            code = _J_WINTOP.sub(_guarded("window"), code)
            code = _J_TOPLOC.sub(_guarded("window.location"), code)
            code = _J_CMP_A.sub(_guarded(lambda m: "window" + m[1] + m[2]), code)
            code = _J_CMP_B.sub(_guarded(lambda m: m[1] + m[2] + "window"), code)
        if "location" in code:
            code = _J_LOCQ.sub(_guarded("__hb$loc"), code)
            code = _J_LOCBARE.sub(_guarded_bare, code)
        return code

    # -- HTML ---------------------------------------------------------
    def _attr(self, m: re.Match) -> str:
        name = m["name"]
        lname = name.lower()
        if m["dq"] is not None:
            q, val = '"', m["dq"]
        elif m["sq"] is not None:
            q, val = "'", m["sq"]
        else:
            q, val = '"', m["uq"]
        if lname in URL_ATTRS:
            new = self.proxify(val)
        elif lname in ("srcset", "imagesrcset"):
            new = self.srcset(val)
        elif lname == "style":
            new = self.css(val)
        elif lname == "integrity":
            return ""  # rewritten resources would fail SRI checks
        elif lname == "content" and _REFRESH.match(val):
            new = _REFRESH.sub(lambda r: r[1] + self.proxify(r[2]), val)
        else:
            return m.group(0)
        if new == val:
            return m.group(0)  # untouched: preserve original quoting byte-for-byte
        return f"{name}{m['eq']}{q}{new}{q}"

    def _chunk(self, m: re.Match) -> str:
        if m["script"] is not None:
            open_tag = _ATTR_RE.sub(self._attr, m["script"])
            body = self.js(m["body"]) if _is_js(m["script"]) else m["body"]
            return open_tag + body + m["close"]
        return _ATTR_RE.sub(self._attr, m["tag"])

    def html(self, text: str, shim_js: str, doc_url: str) -> str:
        text = text.lstrip("\ufeff")
        m = _BASE_TAG.search(text)
        if m:
            h = _BASE_HREF.search(m.group(0))
            if h:
                href = h[1] if h[1] is not None else (h[2] if h[2] is not None else h[3])
                self.base = urljoin(self.base, href)
                self.force_abs = True
            text = text[: m.start()] + text[m.end():]
        text = _CSP_META.sub("", text)
        text = _CHUNK_RE.sub(self._chunk, text)
        text = _STYLE_RE.sub(lambda s: s[1] + self.css(s[2]) + s[3], text)

        shim = build_shim_tag(shim_js, self.prefix, doc_url, self.base)
        m = _HEAD_OPEN.search(text) or _HTML_OPEN.search(text)
        if m:
            pos = m.end()
        else:
            d = _DOCTYPE.match(text)
            pos = d.end() if d else 0
        return text[:pos] + shim + text[pos:]
