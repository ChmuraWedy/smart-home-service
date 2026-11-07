"""Loopback-only translation for short smart-home labels."""

import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

import ctranslate2
import fasttext
import sentencepiece

LANGUAGES = ("en", "ru", "pl", "be")
NUMBER = re.compile(r"\d+")
IDENTIFIER = re.compile(r"[a-z][A-Z]|[_/]|\d")


def is_identifier(text):
    return text.isascii() and " " not in text and bool(IDENTIFIER.search(text))


class Translator:
    def __init__(self):
        self.model = ctranslate2.Translator("/models", compute_type="int8", intra_threads=2)
        self.tokens = sentencepiece.SentencePieceProcessor(model_file="/models/sentencepiece.bpe.model")
        self.languages = fasttext.load_model("/models/lid.176.ftz")

    def source_language(self, value):
        lowered = value.lower()
        if any(char in lowered for char in "іў"):
            return "be"
        if any(char in lowered for char in "ąćęłńóśźż"):
            return "pl"
        labels, scores = self.languages.predict(lowered, k=1)
        source = labels[0].removeprefix("__label__")
        return source if source in LANGUAGES and scores[0] >= 0.30 else None

    def translate(self, originals):
        result = [{} for _ in originals]
        sources, targets, slots = [], [], []
        for index, original in enumerate(originals):
            text = " ".join(original.split())
            if not text or is_identifier(text) or not any(char.isalpha() for char in text):
                continue
            source = self.source_language(text)
            if not source:
                continue
            tokens = [f"__{source}__", *self.tokens.encode(text, out_type=str), "</s>"]
            for language in LANGUAGES:
                if language != source:
                    sources.append(tokens)
                    targets.append([f"__{language}__"])
                    slots.append((index, language))
        if not slots:
            return result
        translations = self.model.translate_batch(
            sources, target_prefix=targets, beam_size=2, max_batch_size=12, max_decoding_length=48,
            return_end_token=False,
        )
        for (index, language), output in zip(slots, translations, strict=True):
            text = self.tokens.decode(output.hypotheses[0][1:]).strip()
            original = originals[index]
            if (
                text and text.casefold() != original.casefold()
                and NUMBER.findall(text) == NUMBER.findall(original)
                and len(text) <= min(120, len(original) * 3 + 12)
            ):
                result[index][language] = text
        return result


def serve(translator):
    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, {"status": "ok"})
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path != "/translate":
                self.send_error(404)
                return
            self.connection.settimeout(5)
            try:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 32768:
                    raise ValueError
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, list) or not 1 <= len(body) <= 33:
                    raise ValueError
                if any(not isinstance(text, str) or not 1 <= len(text) <= 120 for text in body):
                    raise ValueError
            except (ValueError, OSError):
                self.send_json(400, {"error": "Invalid labels"})
                return
            try:
                self.send_json(200, translator.translate(body))
            except (BrokenPipeError, ConnectionResetError):
                pass

    HTTPServer(("127.0.0.1", 8093), Handler).serve_forever()


if __name__ == "__main__":
    serve(Translator())
