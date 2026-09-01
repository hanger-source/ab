#!/usr/bin/env python3
"""Attach the official VisualWebArena evaluator to an AB-owned Chrome tab."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


IMPORT_ONLY_OPENAI_KEY = "ab-visualwebarena-import-only"


def load_official_modules(source: Path) -> dict[str, Any]:
    sys.path.insert(0, str(source))
    os.chdir(source)

    from browser_env.actions import create_stop_action
    from evaluation_harness.evaluators import evaluator_router
    from playwright.sync_api import sync_playwright

    return {
        "create_stop_action": create_stop_action,
        "evaluator_router": evaluator_router,
        "sync_playwright": sync_playwright,
    }


def requires_openai_evaluator(config: Any) -> bool:
    """Return true only for official rules that actually call the OpenAI judge."""
    if isinstance(config, dict):
        if any(key in config for key in ("fuzzy_match", "ua_match")):
            return True
        return any(requires_openai_evaluator(value) for value in config.values())
    if isinstance(config, list):
        return any(requires_openai_evaluator(value) for value in config)
    return False


def allow_offline_official_import() -> None:
    # VisualWebArena's helper_functions imports openai_utils eagerly, and that
    # module constructs clients at import time even for URL/HTML/SSIM/local-BLIP
    # evaluators. A syntactically valid process-local key lets those official
    # modules load; it is never used for a task whose evaluator needs OpenAI.
    os.environ.setdefault("OPENAI_API_KEY", IMPORT_ONLY_OPENAI_KEY)


def configure_doctor_environment() -> None:
    os.environ.setdefault("DATASET", "visualwebarena")
    os.environ.setdefault("CLASSIFIEDS", "https://classifieds.invalid")
    os.environ.setdefault("REDDIT", "https://reddit.invalid")
    os.environ.setdefault("SHOPPING", "https://shopping.invalid")
    os.environ.setdefault("WIKIPEDIA", "https://wikipedia.invalid")
    os.environ.setdefault("HOMEPAGE", "https://homepage.invalid")
    os.environ.setdefault("CLASSIFIEDS_RESET_TOKEN", "doctor")


def captioning_function(source: Path, config: dict[str, Any]) -> Any:
    if "page_image_query" not in config["eval"]["eval_types"]:
        return None

    import torch
    from evaluation_harness import image_utils

    device_name = os.environ.get("AB_VISUALWEBARENA_EVAL_DEVICE", "cpu")
    model_name = os.environ.get(
        "AB_VISUALWEBARENA_EVAL_CAPTION_MODEL",
        "Salesforce/blip2-flan-t5-xl",
    )
    device = torch.device(device_name)
    dtype = torch.float16 if device_name == "cuda" else torch.float32
    os.chdir(source)
    return image_utils.get_captioning_fn(device, dtype, model_name)


def target_page(browser: Any, target_id: str) -> Any:
    matches = []
    for context in browser.contexts:
        for page in context.pages:
            session = context.new_cdp_session(page)
            try:
                info = session.send("Target.getTargetInfo")["targetInfo"]
            finally:
                session.detach()
            if info["targetId"] == target_id:
                matches.append(page)
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one Playwright page for AB target {target_id}, found {len(matches)}"
        )
    return matches[0]


def evaluate(args: argparse.Namespace, modules: dict[str, Any], source: Path) -> None:
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text())
    caption = captioning_function(source, config)
    trajectory = [modules["create_stop_action"](args.answer)]

    with modules["sync_playwright"]() as playwright:
        browser = playwright.chromium.connect_over_cdp(args.cdp_endpoint)
        page = target_page(browser, args.target_id)
        evaluator = modules["evaluator_router"](
            config_path,
            captioning_fn=caption,
        )
        score = float(evaluator(trajectory, config_path, page))
        final_url = page.url

    result = {
        "evaluator": "official-visualwebarena",
        "evalTypes": config["eval"]["eval_types"],
        "score": score,
        "targetId": args.target_id,
        "finalUrl": final_url,
    }
    print("AB_VISUALWEBARENA_EVALUATION " + json.dumps(result, separators=(",", ":")))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["doctor", "evaluate"])
    parser.add_argument("--source", required=True)
    parser.add_argument("--config")
    parser.add_argument("--cdp-endpoint")
    parser.add_argument("--target-id")
    parser.add_argument("--answer", default="")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    if args.command == "doctor":
        credential_provided = bool(os.environ.get("OPENAI_API_KEY"))
        configure_doctor_environment()
        allow_offline_official_import()
        load_official_modules(source)
        print(
            json.dumps(
                {
                    "ready": True,
                    "source": str(source),
                    "openaiCredential": (
                        "provided" if credential_provided else "task-dependent"
                    ),
                }
            )
        )
        return

    for name in ("config", "cdp_endpoint", "target_id"):
        if not getattr(args, name):
            parser.error(f"--{name.replace('_', '-')} is required for evaluate")
    config = json.loads(Path(args.config).resolve().read_text())
    if requires_openai_evaluator(config) and not os.environ.get("OPENAI_API_KEY"):
        parser.error(
            "this task uses VisualWebArena fuzzy/UA evaluation and requires "
            "OPENAI_API_KEY"
        )
    allow_offline_official_import()
    modules = load_official_modules(source)
    evaluate(args, modules, source)


if __name__ == "__main__":
    main()
