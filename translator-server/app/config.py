from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8765


class TranslationConfig(BaseModel):
    backend: Literal["ollama", "ct2_opus", "ct2_m2m", "mock"] = "ollama"


class OllamaConfig(BaseModel):
    base_url: str = "http://127.0.0.1:11434"
    model: str = "qwen2.5:3b"
    temperature: float = 0.1
    num_ctx: int = 512
    num_predict: int = 120
    timeout_sec: float = 8
    keep_alive: str = "10m"
    context_items: int = 4
    prompt_style: Literal["красивый", "короткий"] = "красивый"


class Ct2OpusConfig(BaseModel):
    model_path: str = "D:/AI/Models/opus-mt-en-ru-ctranslate2"
    device: str = "cpu"
    compute_type: str = "int8"
    inter_threads: int = 1
    intra_threads: int = 4
    max_input_chars: int = 500


class Ct2M2MConfig(BaseModel):
    model_path: str = "D:/AI/Models/m2m100"
    device: str = "cpu"
    compute_type: str = "int8"
    source_lang: str = "en"
    target_lang: str = "ru"


class RuntimeConfig(BaseModel):
    cache_size: int = 1024
    max_input_chars: int = 800
    request_timeout_sec: float = 8
    max_concurrent_translations: int = Field(default=1, ge=1, le=1)
    log_translations: bool = True
    translation_log_path: str = "logs/translations.jsonl"
    translation_log_per_run: bool = True
    warmup_on_start: bool = True
    warmup_timeout_sec: float = 45
    warmup_text: str = "Hello, welcome to the keynote."


class AppConfig(BaseModel):
    server: ServerConfig = ServerConfig()
    translation: TranslationConfig = TranslationConfig()
    ollama: OllamaConfig = OllamaConfig()
    ct2_opus: Ct2OpusConfig = Ct2OpusConfig()
    ct2_m2m: Ct2M2MConfig = Ct2M2MConfig()
    runtime: RuntimeConfig = RuntimeConfig()


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    config_path = Path(path)
    if not config_path.exists():
        example_path = Path("config.example.yaml")
        config_path = example_path if example_path.exists() else config_path
    data = {}
    if config_path.exists():
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    return AppConfig.model_validate(data)
