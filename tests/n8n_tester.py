#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
n8n workflow unit tester

Implements:
- .utn8n YAML parsing (validated format above)
- Exactly one trigger per test (type: "trigger" or "webhook")
- For type="trigger": patches the workflow JSON by adding
  a Manual Trigger + Set ("Edit Fields") that outputs the test's input JSON,
  wired to the same downstream nodes as the real trigger node.
- For type="webhook": POSTs to the provided webhook_url with the test input
  and validates the HTTP response (code/body).
- Uses `n8n import:workflow --input <json> --overwrite` then
  `n8n execute --id <workflowId> --rawOutput`
- Extracts the JSON from mixed CLI output robustly
- Compares node outputs:
    - `data` (exact JSON match against the first item)
    - `includeFields` (presence check)
    - `executionStatus` (string match)
    - `errorMessage` (present in node error or top-level error)
- Optional `preCommand` and `postCommand` per node
    - `postCommandExpectedOutput` must match stdout.strip()
"""

import argparse
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from typing import Any, Dict, List, Tuple

import requests
import yaml


# ----------------------------- Utilities ---------------------------------- #

def log(msg: str) -> None:
    print(msg, flush=True)


def run_cmd(cmd: str, *, check: bool = False) -> Tuple[int, str, str]:
    """Run a shell command, return (code, stdout, stderr)."""
    proc = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {cmd}\n"
                           f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return proc.returncode, proc.stdout, proc.stderr


def extract_first_json_object(text: str) -> Dict[str, Any]:
    """
    Extract the first well-formed JSON object from mixed text by brace counting,
    honoring quotes/escapes.
    """
    s = text
    start = s.find("{")
    if start == -1:
        raise ValueError("No JSON object found in n8n output.")
    depth, in_str, esc = 0, False, False
    end = None
    for i, ch in enumerate(s[start:], start=start):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == "\"":
                in_str = False
        else:
            if ch == "\"":
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
    if end is None:
        raise ValueError("Unterminated JSON in n8n output.")
    blob = s[start:end]
    return json.loads(blob)


def deep_get(d: Dict[str, Any], path: List[str], default=None):
    cur = d
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return default
        cur = cur[p]
    return cur


def ensure_one_trigger(nodes_cfg: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    triggers = []
    for node_name, spec in nodes_cfg.items():
        typ = str(spec.get("type", "")).lower()
        if typ in ("trigger", "webhook"):
            triggers.append((node_name, spec))
    if len(triggers) != 1:
        raise ValueError(f"Each test must have exactly one trigger/webhook node, found: {len(triggers)}")
    return triggers[0]


def json_min(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def first_item_json_from_run(entry: Dict[str, Any]) -> Dict[str, Any]:
    data = entry.get("data", {})
    main = data.get("main", [])
    for branch in main:
        for item in branch:
            if isinstance(item, dict) and "json" in item:
                return item["json"]
    return {}


def flatten_items(entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    out = []
    data = entry.get("data", {})
    for branch in data.get("main", []):
        for item in branch:
            if isinstance(item, dict) and "json" in item:
                out.append(item["json"])
    return out


def pretty(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


# ----------------------- Workflow patching (trigger) ---------------------- #

def patch_workflow_for_manual_trigger(
    wf: Dict[str, Any],
    real_trigger_node_name: str,
    input_json: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Adds:
      - Manual Trigger node
      - Set node ("Edit Fields") that outputs input_json (as raw JSON string)
    Wires: Manual -> Edit Fields -> original trigger's downstream(s)
    Keeps original connections intact.
    """
    wf = copy.deepcopy(wf)

    # Collect downstream connections of the real trigger
    connections = wf.setdefault("connections", {})
    downstream = []
    if real_trigger_node_name in connections:
        main = connections[real_trigger_node_name].get("main", [])
        if main and isinstance(main[0], list):
            downstream = copy.deepcopy(main[0])

    # Build new nodes
    man_id = str(uuid.uuid4())
    set_id = str(uuid.uuid4())

    manual_name = "When clicking ‘Execute workflow’"
    set_name = "Edit Fields"

    manual_node = {
        "parameters": {},
        "type": "n8n-nodes-base.manualTrigger",
        "typeVersion": 1,
        "position": [0, -192],
        "id": man_id,
        "name": manual_name,
    }
    set_node = {
        "parameters": {
            "mode": "raw",
            "jsonOutput": pretty(input_json),
            "options": {}
        },
        "type": "n8n-nodes-base.set",
        "typeVersion": 3.4,
        "position": [224, -192],
        "id": set_id,
        "name": set_name,
    }

    wf.setdefault("nodes", []).extend([manual_node, set_node])

    # Wire Manual -> Edit Fields
    connections[manual_name] = {
        "main": [[{"node": set_name, "type": "main", "index": 0}]]
    }
    # Wire Edit Fields -> original trigger's downstreams
    connections[set_name] = {"main": [downstream]}

    return wf


# ------------------------------ Comparisons ------------------------------- #

def compare_node_expectations(
    node_name: str,
    node_spec: Dict[str, Any],
    run_json: Dict[str, Any],
) -> List[str]:
    """
    Returns list of failure messages for this node (empty if passed).
    """
    fails = []
    run_data = deep_get(run_json, ["data", "resultData", "runData"], {})
    entries = run_data.get(node_name)
    if not entries:
        fails.append(f'Node "{node_name}": not found in runData')
        return fails

    last = entries[-1]
    # executionStatus
    if "executionStatus" in node_spec:
        want = str(node_spec["executionStatus"])
        got = str(last.get("executionStatus"))
        if want != got:
            fails.append(f'Node "{node_name}": executionStatus mismatch (want={want}, got={got})')

    # errorMessage
    if "errorMessage" in node_spec:
        want_err = str(node_spec["errorMessage"])
        node_err = deep_get(last, ["error", "message"])
        top_err = deep_get(run_json, ["data", "resultData", "error", "message"])
        if want_err not in (node_err or "") and want_err not in (top_err or ""):
            fails.append(f'Node "{node_name}": expected errorMessage "{want_err}" not found')

    # data or includeFields
    if "data" in node_spec:
        want_json = node_spec["data"]
        got_json = first_item_json_from_run(last)
        if want_json != got_json:
            fails.append(
                f'Node "{node_name}": data mismatch\n  want={pretty(want_json)}\n  got ={pretty(got_json)}'
            )

    if "includeFields" in node_spec:
        fields = list(node_spec["includeFields"])
        items = flatten_items(last)
        if not items:
            fails.append(f'Node "{node_name}": expected includeFields but no items were output')
        else:
            got = items[0]
            missing = [f for f in fields if f not in got]
            if missing:
                fails.append(f'Node "{node_name}": missing fields {missing} in {pretty(got)}')

    return fails


# ------------------------------ Runner core ------------------------------- #

class N8NTester:
    def __init__(self, n8n_cli_prefix: str = "n8n", verbose: bool = False):
        """
        n8n_cli_prefix examples:
          - "n8n"
          - "docker exec <container_id> n8n"
        """
        self.n8n = n8n_cli_prefix.strip()
        self.verbose = verbose

    # ---- n8n CLI helpers ---- #

    def import_workflow(self, json_path: str) -> None:
        code, out, err = run_cmd(f'{self.n8n} import:workflow --input "{json_path}" --overwrite')
        if self.verbose:
            log(out)
            log(err)
        if code != 0:
            raise RuntimeError(f"Failed to import workflow from {json_path}")

    def execute_workflow(self, workflow_id: str) -> Dict[str, Any]:
        code, out, err = run_cmd(f"{self.n8n} execute --id {workflow_id} --rawOutput")
        if self.verbose:
            log(out)
            log(err)
        return extract_first_json_object(out + "\n" + err)

    # ---- HTTP (webhook) ---- #

    def call_webhook(self, url: str, payload: Dict[str, Any]) -> Tuple[int, str]:
        r = requests.post(url, json=payload, timeout=30)
        body = r.text
        return r.status_code, body

    # ---- single test ---- #

    def run_test(
        self,
        wf_id: str,
        wf_path: str,
        test_id: str,
        test_cfg: Dict[str, Any],
    ) -> Tuple[bool, List[str]]:
        """
        Returns (passed?, messages[])
        """
        name = test_cfg.get("name", test_id)
        nodes_cfg: Dict[str, Any] = test_cfg.get("nodes", {})
        trig_name, trig_spec = ensure_one_trigger(nodes_cfg)
        trig_type = str(trig_spec.get("type", "")).lower()

        # optional preCommands (per node)
        for node, spec in nodes_cfg.items():
            pre = spec.get("preCommand")
            if pre:
                code, out, err = run_cmd(pre)
                if self.verbose:
                    log(f"[preCommand:{node}] rc={code}\n{out}\n{err}")
                if code != 0:
                    return False, [f"{name}: preCommand for node '{node}' failed (rc={code})"]

        # Decide execution path
        if trig_type == "webhook":
            # Only webhook node is checked; we don't trace intermediate nodes.
            url = trig_spec.get("webhook_url")
            if not url:
                return False, [f"{name}: webhook_url missing for webhook trigger"]
            payload = trig_spec.get("data", {})
            status, body = self.call_webhook(url, payload)
            fails: List[str] = []

            if "responseCode" in trig_spec and int(trig_spec["responseCode"]) != int(status):
                fails.append(f"responseCode mismatch (want={trig_spec['responseCode']}, got={status})")

            if "responseData" in trig_spec:
                want = str(trig_spec["responseData"])
                if want != body:
                    fails.append(f"responseData mismatch\n  want={want}\n  got ={body}")

            # postCommand (global after webhook)
            for node, spec in nodes_cfg.items():
                post = spec.get("postCommand")
                if post:
                    code, out, err = run_cmd(post)
                    out = (out or "").strip()
                    want_out = str(spec.get("postCommandExpectedOutput", ""))
                    if out != want_out:
                        fails.append(f"[postCommand:{node}] stdout mismatch (want={want_out}, got={out})")

            return (len(fails) == 0, [name] + (["PASS"] if not fails else fails))

        # type="trigger"
        # Read workflow JSON
        try:
            with open(wf_path, "r", encoding="utf-8") as f:
                wf_json = json.load(f)
        except Exception as e:
            return False, [f"{name}: failed to read workflow JSON at {wf_path}: {e}"]

        # Prepare patched workflow
        trig_input = trig_spec.get("data", {})
        patched = patch_workflow_for_manual_trigger(wf_json, trig_name, trig_input)

        # Write to temp, import, execute
        with tempfile.TemporaryDirectory() as td:
            tmp_json = os.path.join(td, "patched_workflow.json")
            with open(tmp_json, "w", encoding="utf-8") as f:
                json.dump(patched, f, ensure_ascii=False)

            self.import_workflow(tmp_json)
            run_json = self.execute_workflow(wf_json.get("id") or wf_id)

        # Compare expectations for all non-trigger nodes
        all_fails: List[str] = []
        for node_name, node_spec in nodes_cfg.items():
            if node_name == trig_name:
                continue  # skip input node
            t = str(node_spec.get("type", "")).lower()
            if t not in ("node", "output"):
                all_fails.append(f'Node "{node_name}": unsupported type "{t}" (expected node/output)')
                continue
            all_fails.extend(compare_node_expectations(node_name, node_spec, run_json))

        # postCommands
        for node_name, node_spec in nodes_cfg.items():
            post = node_spec.get("postCommand")
            if post:
                code, out, err = run_cmd(post)
                out = (out or "").strip()
                want_out = str(node_spec.get("postCommandExpectedOutput", ""))
                if out != want_out:
                    all_fails.append(f'[postCommand:{node_name}] stdout mismatch (want="{want_out}", got="{out}")')

        return (len(all_fails) == 0, [name] + (["PASS"] if not all_fails else all_fails))

    # ---- all tests in one workflow ---- #

    def run_workflow_tests(self, wf_id: str, wf_cfg: Dict[str, Any]) -> Tuple[int, int]:
        wf_path = wf_cfg.get("workflow_dir")
        if not wf_path or not os.path.exists(wf_path):
            raise FileNotFoundError(f'workflow_dir not found for "{wf_id}": {wf_path}')

        tests: Dict[str, Any] = wf_cfg.get("tests", {})
        passed, total = 0, 0
        for test_id, test_cfg in tests.items():
            total += 1
            ok, messages = self.run_test(wf_id, wf_path, test_id, test_cfg)
            status = "✅ PASS" if ok else "❌ FAIL"
            log(f"\n[{wf_id} :: {test_id}] {status}")
            for m in messages:
                if isinstance(m, str):
                    log(f"  - {m}")
            if ok:
                passed += 1
        return passed, total


# --------------------------------- CLI ------------------------------------ #

def main():
    parser = argparse.ArgumentParser(description="n8n workflow unit tester")
    parser.add_argument("utn8n", help="Path to the .utn8n (YAML) file")
    parser.add_argument(
        "--n8n",
        default=os.environ.get("N8N_CLI", "n8n"),
        help='Command prefix to run n8n (e.g. "n8n" or "docker exec <cid> n8n"). '
             'Can also be set via N8N_CLI env var.',
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose CLI logs")
    args = parser.parse_args()

    with open(args.utn8n, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    runner = N8NTester(n8n_cli_prefix=args.n8n, verbose=args.verbose)

    grand_total = 0
    grand_passed = 0
    for wf_id, wf_cfg in cfg.items():
        log(f"\n=== Running tests for workflow: {wf_id} ===")
        p, t = runner.run_workflow_tests(wf_id, wf_cfg)
        log(f"==> {wf_id}: {p}/{t} passed")
        grand_passed += p
        grand_total += t

    log(f"\n💡 All done: {grand_passed}/{grand_total} tests passed.")
    sys.exit(0 if grand_passed == grand_total else 1)


if __name__ == "__main__":
    main()
