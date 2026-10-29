# SPDX-License-Identifier: AGPL-3.0-only
# Derived from PDFMathTranslate-next 2.9.0 translator_impl/bing.py; see THIRD_PARTY.md.
import logging
import re

import requests
from pdf2zh_next.config.model import SettingsModel
from pdf2zh_next.translator.base_rate_limiter import BaseRateLimiter
from pdf2zh_next.translator.base_translator import BaseTranslator
from tenacity import before_sleep_log
from tenacity import retry
from tenacity import retry_if_exception
from tenacity import stop_after_attempt
from tenacity import wait_exponential

logger = logging.getLogger(__name__)


class BingTranslator(BaseTranslator):
    # https://github.com/immersive-translate/old-immersive-translate/blob/6df13da22664bea2f51efe5db64c63aca59c4e79/src/background/translationService.js
    name = "bing"
    lang_map = {"zh": "zh-Hans", "zh-cn": "zh-Hans", "zh-tw": "zh-Hant", "auto": "en"}

    def __init__(
        self,
        settings: SettingsModel,
        rate_limiter: BaseRateLimiter,
    ):
        super().__init__(settings, rate_limiter)
        self.session = requests.Session()
        self.endpoint = "https://www.bing.com/translator"
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",  # noqa: E501
        }

    def find_sid(self):
        response = self.session.get(self.endpoint, timeout=30)
        response.raise_for_status()
        url = response.url[:-10]
        ig = re.findall(r"\"ig\":\"(.*?)\"", response.text)[0]
        iid = re.findall(r"data-iid=\"(.*?)\"", response.text)[-1]
        key, token = re.findall(
            r"params_AbusePreventionHelper\s=\s\[(.*?),\"(.*?)\",", response.text
        )[0]
        return url, ig, iid, key, token

    @retry(
        retry=retry_if_exception(Exception),
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=1, min=1, max=15),
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )
    def do_translate(self, text, rate_limit_params: dict = None):
        url, ig, iid, key, token = self.find_sid()
        # Paper Companion compatibility patch: preserve every character in long paragraphs.
        results = []
        remaining = text
        while remaining:
            end = min(1000, len(remaining))
            if end < len(remaining):
                boundary = max(remaining.rfind('. ', 0, end), remaining.rfind('; ', 0, end))
                if boundary < 400:
                    boundary = remaining.rfind(' ', 0, end)
                if boundary >= 0:
                    end = boundary + 1
            chunk, remaining = remaining[:end], remaining[end:]
            if results and hasattr(self, 'rate_limiter'):
                self.rate_limiter.wait(rate_limit_params)
            response = self.session.post(
                f"{url}ttranslatev3?IG={ig}&IID={iid}",
                data={"fromLang": self.lang_in, "to": self.lang_out,
                      "text": chunk, "token": token, "key": key},
                headers=self.headers, timeout=30,
            )
            response.raise_for_status()
            translated = response.json()[0]["translations"][0]["text"]
            if not translated.strip() and chunk.strip():
                raise ValueError('Bing returned an empty translation')
            results.append(translated)
        return ' '.join(results)
