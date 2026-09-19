"""Direct-mode tests for MandateGate (GenVM v0.6.0-rc5 SDK, leader path + captured validator)."""
import json
import pytest

CONTRACT = "contracts/mandate_gate.py"
SDK = "v0.6.0-rc5"
MANDATE = (
    "Authorize a liquidity allocation only when authoritative evidence establishes that the evidence "
    "refers to the configured pool and token identities, the pool is currently active and supported, "
    "and no authoritative submitted source reports an active suspension, exploit, deprecation, or "
    "material operational warning. Conflicting, ambiguous, non-authoritative, or incomplete evidence "
    "is insufficient."
)
PAIR = "WETH/USDC"
POOL = "HBX-WETH-USDC-5BP"
HOST = "mandate-gate-azure.vercel.app"
ACTIVE = "https://mandate-gate-azure.vercel.app/evidence/pool-active.html"
WARNING = "https://mandate-gate-azure.vercel.app/evidence/pool-warning.html"
AMBIGUOUS = "https://mandate-gate-azure.vercel.app/evidence/pool-ambiguous.html"
RATIONALE = "Deploy idle stablecoin reserve into the configured WETH/USDC pool."

FINDINGS = {
    "COMPLIANT": {"identity": "CONFIRMED", "pool_state": "ACTIVE_SUPPORTED", "adverse_report": "NONE_REPORTED",
                  "authoritative_source": True, "conflicting": False},
    "NON_COMPLIANT": {"identity": "CONFIRMED", "pool_state": "INACTIVE_OR_UNSUPPORTED", "adverse_report": "REPORTED",
                      "authoritative_source": True, "conflicting": False},
    "INSUFFICIENT_EVIDENCE": {"identity": "MISMATCH", "pool_state": "UNCLEAR", "adverse_report": "UNCLEAR",
                              "authoritative_source": True, "conflicting": False},
}


def llm(value) -> str:
    """gltest json-parses a mock string once and the v0.6 SDK parses the text again."""
    return json.dumps(json.dumps(value))


def mock(vm, kind="COMPLIANT", url=ACTIVE, body="Registry record for HBX-WETH-USDC-5BP", **overrides):
    vm.clear_mocks()
    vm.mock_web(r"mandate-gate-azure.vercel.app", {"status": 200, "body": body})
    reply = dict(FINDINGS[kind], supporting_urls=[url], reasoning="The registry record states the finding.")
    reply.update(overrides)
    vm.mock_llm(r"MANDATEGATE_ADJUDICATION", llm(reply))


@pytest.fixture
def gate(direct_vm, direct_deploy):
    direct_vm.warp("2026-09-18T12:00:00Z")
    return direct_deploy(CONTRACT, MANDATE, "v1", PAIR, POOL, HOST, 100_000, 25_000, sdk_version=SDK)


def submit(gate, pid="p-001", amount=10_000, urls=(ACTIVE,), pair=PAIR, pool=POOL, rationale=RATIONALE):
    return gate.evaluate_proposal(pid, pair, pool, amount, rationale, list(urls))


def budget(gate):
    return json.loads(gate.get_budget())


def proposal(gate, pid):
    return json.loads(gate.get_proposal(pid))


# ---------------------------------------------------------------- initialisation

def test_initialisation(gate, direct_owner):
    mandate = json.loads(gate.get_mandate())
    assert mandate["mandate_text"] == MANDATE
    assert mandate["mandate_version"] == "v1"
    assert mandate["pair"] == PAIR and mandate["pool_id"] == POOL
    assert mandate["registry_host"] == HOST
    assert mandate["owner"] == direct_owner.as_hex.lower()
    assert budget(gate) == {"total_cap": 100_000, "per_proposal_cap": 25_000, "reserved": 0, "available": 100_000}
    assert json.loads(gate.get_summary())["proposals"] == 0
    assert gate.get_version() == "mandate-gate/1.0"


def test_constructor_rejects_per_cap_above_total(direct_vm, direct_deploy):
    with direct_vm.expect_revert("per-proposal cap"):
        direct_deploy(CONTRACT, MANDATE, "v1", PAIR, POOL, HOST, 10_000, 25_000, sdk_version=SDK)


def test_constructor_rejects_non_positive_cap(direct_vm, direct_deploy):
    with direct_vm.expect_revert("positive"):
        direct_deploy(CONTRACT, MANDATE, "v1", PAIR, POOL, HOST, 0, 0, sdk_version=SDK)


# ----------------------------------------------------------- the three statuses

def test_compliant_reserves_budget(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    assert submit(gate) == "COMPLIANT"
    record = proposal(gate, "p-001")
    assert record["status"] == "COMPLIANT"
    assert record["reason_codes"] == ["IDENTITY_CONFIRMED", "POOL_ACTIVE_SUPPORTED", "NO_ADVERSE_REPORTS"]
    assert record["authorization"] == "RESERVED" and record["reserved_amount"] == 10_000
    assert record["supporting_urls"] == [ACTIVE]
    assert budget(gate)["reserved"] == 10_000 and budget(gate)["available"] == 90_000
    assert direct_vm.run_validator() is True


def test_non_compliant_leaves_budget_unchanged(gate, direct_vm):
    mock(direct_vm, "NON_COMPLIANT", url=WARNING)
    assert submit(gate, urls=(WARNING,)) == "NON_COMPLIANT"
    record = proposal(gate, "p-001")
    assert record["reason_codes"] == ["ADVERSE_REPORT", "POOL_NOT_ACTIVE"]
    assert record["authorization"] == "NONE" and record["reserved_amount"] == 0
    assert budget(gate)["reserved"] == 0
    assert direct_vm.run_validator() is True


def test_insufficient_evidence_leaves_budget_unchanged(gate, direct_vm):
    mock(direct_vm, "INSUFFICIENT_EVIDENCE", url=AMBIGUOUS)
    assert submit(gate, urls=(AMBIGUOUS,)) == "INSUFFICIENT_EVIDENCE"
    record = proposal(gate, "p-001")
    assert record["reason_codes"] == ["IDENTITY_MISMATCH"]
    assert record["authorization"] == "NONE"
    assert budget(gate)["reserved"] == 0
    summary = json.loads(gate.get_summary())
    assert summary["insufficient_evidence"] == 1 and summary["compliant"] == 0


@pytest.mark.parametrize("overrides,codes", [
    ({"authoritative_source": False}, ["NON_AUTHORITATIVE_EVIDENCE"]),
    ({"identity": "UNCLEAR"}, ["IDENTITY_UNCLEAR"]),
    ({"conflicting": True}, ["CONFLICTING_EVIDENCE"]),
    ({"pool_state": "UNCLEAR"}, ["POOL_STATE_UNCLEAR"]),
    ({"adverse_report": "UNCLEAR"}, ["INCOMPLETE_EVIDENCE"]),
])
def test_doubtful_findings_are_insufficient(gate, direct_vm, overrides, codes):
    mock(direct_vm, "COMPLIANT", **overrides)
    assert submit(gate) == "INSUFFICIENT_EVIDENCE"
    assert proposal(gate, "p-001")["reason_codes"] == codes
    assert budget(gate)["reserved"] == 0


def test_unreachable_evidence_is_insufficient_without_model(gate, direct_vm):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"mandate-gate-azure.vercel.app", {"status": 503, "body": "down"})
    assert submit(gate) == "INSUFFICIENT_EVIDENCE"
    record = proposal(gate, "p-001")
    assert record["reason_codes"] == ["EVIDENCE_UNAVAILABLE"]
    assert record["sources"] == [{"url": ACTIVE, "ok": False, "error": "HTTP_503"}]
    assert budget(gate)["reserved"] == 0


def test_supporting_urls_are_limited_to_submitted_sources(gate, direct_vm):
    mock(direct_vm, "COMPLIANT", supporting_urls=[ACTIVE, "https://attacker.example/x"])
    submit(gate)
    assert proposal(gate, "p-001")["supporting_urls"] == [ACTIVE]


def test_malformed_llm_output_reverts_without_state(gate, direct_vm):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"mandate-gate-azure.vercel.app", {"status": 200, "body": "record"})
    direct_vm.mock_llm(r"MANDATEGATE_ADJUDICATION", llm({"identity": "PROBABLY", "verdict": "yes"}))
    with direct_vm.expect_revert("LLM_ERROR"):
        submit(gate)
    assert json.loads(gate.get_summary())["proposals"] == 0
    assert budget(gate)["reserved"] == 0


# ---------------------------------------------------------------- validator

def test_validator_rejects_status_that_contradicts_findings(gate, direct_vm):
    mock(direct_vm, "INSUFFICIENT_EVIDENCE", url=AMBIGUOUS)
    submit(gate, urls=(AMBIGUOUS,))
    forged = {"status": "COMPLIANT", "reason_codes": ["IDENTITY_CONFIRMED", "POOL_ACTIVE_SUPPORTED", "NO_ADVERSE_REPORTS"],
              "reasoning": "x", "supporting_urls": [], "sources": [],
              "findings": dict(FINDINGS["INSUFFICIENT_EVIDENCE"], any_source_available=True)}
    assert direct_vm.run_validator(leader_result=forged) is False


def test_validator_disagrees_when_its_evidence_differs(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    submit(gate)
    # The validator re-fetches and sees an adverse registry entry.
    mock(direct_vm, "NON_COMPLIANT", url=WARNING)
    assert direct_vm.run_validator() is False


def test_validator_tolerates_prose_differences(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    submit(gate)
    mock(direct_vm, "COMPLIANT", reasoning="Different wording, same substantive finding.", supporting_urls=[])
    assert direct_vm.run_validator() is True


def test_validator_rejects_foreign_supporting_url(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    submit(gate)
    record = proposal(gate, "p-001")
    leader = {k: record[k] for k in ("status", "reason_codes", "reasoning", "supporting_urls", "findings", "sources")}
    leader["supporting_urls"] = ["https://not-submitted.example/page"]
    assert direct_vm.run_validator(leader_result=leader) is False


# ----------------------------------------------------- deterministic rejections

def test_duplicate_proposal_id(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    submit(gate)
    with direct_vm.expect_revert("DUPLICATE"):
        submit(gate)
    assert budget(gate)["reserved"] == 10_000


def test_non_compliant_id_cannot_be_reused(gate, direct_vm):
    mock(direct_vm, "NON_COMPLIANT", url=WARNING)
    submit(gate, urls=(WARNING,))
    mock(direct_vm, "COMPLIANT")
    with direct_vm.expect_revert("DUPLICATE"):
        submit(gate)


@pytest.mark.parametrize("pair,pool", [("WBTC/USDC", POOL), (PAIR, "HBX-WETH-USDT-5BP"), (PAIR, "hbx-weth-usdc-5bp")])
def test_pair_and_pool_must_match(gate, direct_vm, pair, pool):
    with direct_vm.expect_revert("IDENTITY"):
        submit(gate, pair=pair, pool=pool)


def test_pair_match_is_case_insensitive(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    assert submit(gate, pair="weth/usdc") == "COMPLIANT"


@pytest.mark.parametrize("amount,message", [(0, "positive"), (-5, "positive"), (25_001, "per-proposal cap")])
def test_amount_limits(gate, direct_vm, amount, message):
    with direct_vm.expect_revert(message):
        submit(gate, amount=amount)


def test_per_proposal_cap_is_inclusive(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    assert submit(gate, amount=25_000) == "COMPLIANT"


def test_total_cap_enforced(gate, direct_vm):
    for index in range(4):
        mock(direct_vm, "COMPLIANT")
        submit(gate, pid=f"fill-{index}", amount=25_000)
    assert budget(gate) == {"total_cap": 100_000, "per_proposal_cap": 25_000, "reserved": 100_000, "available": 0}
    with direct_vm.expect_revert("available authorization budget"):
        submit(gate, pid="overflow", amount=1)


@pytest.mark.parametrize("urls,message", [
    ((), "between 1 and 3"),
    ((ACTIVE, WARNING, AMBIGUOUS, "https://example.com/4"), "between 1 and 3"),
    (("http://mandate-gate-azure.vercel.app/evidence/pool-active.html",), "https://"),
    (("ftp://example.com/a",), "https://"),
    (("https://user:pw@example.com/a",), "https://"),
    (("https://example.com:8443/a",), "https://"),
    (("https://localhost/a",), "public DNS"),
    (("https://127.0.0.1/a",), "public DNS"),
    (("https://example.com/" + "a" * 300,), "exceeds"),
    ((ACTIVE, ACTIVE), "distinct"),
])
def test_url_validation(gate, direct_vm, urls, message):
    with direct_vm.expect_revert(message):
        submit(gate, urls=urls)


@pytest.mark.parametrize("pid", ["ab", "has space", "x" * 49, "-leading", "semi;colon"])
def test_proposal_id_validation(gate, direct_vm, pid):
    with direct_vm.expect_revert("proposal ID"):
        submit(gate, pid=pid)


@pytest.mark.parametrize("rationale", ["too short", "x" * 601])
def test_rationale_length(gate, direct_vm, rationale):
    with direct_vm.expect_revert("rationale"):
        submit(gate, rationale=rationale)


def test_oversized_evidence_is_not_used(gate, direct_vm):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"mandate-gate-azure.vercel.app", {"status": 200, "body": "x" * 700_000})
    assert submit(gate) == "INSUFFICIENT_EVIDENCE"
    assert proposal(gate, "p-001")["sources"][0]["error"] == "TOO_LARGE"


# ---------------------------------------------------------------- cancellation

def test_owner_cancellation_releases_reservation(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    submit(gate, amount=20_000)
    assert budget(gate)["reserved"] == 20_000
    gate.cancel_authorization("p-001")
    record = proposal(gate, "p-001")
    assert record["authorization"] == "CANCELLED" and record["reserved_amount"] == 0
    assert record["status"] == "COMPLIANT"  # the judgment itself is history
    assert budget(gate)["reserved"] == 0
    assert json.loads(gate.get_summary())["cancelled"] == 1
    with direct_vm.expect_revert("no active reservation"):
        gate.cancel_authorization("p-001")


def test_only_owner_can_cancel(gate, direct_vm, direct_bob):
    mock(direct_vm, "COMPLIANT")
    submit(gate)
    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("FORBIDDEN"):
            gate.cancel_authorization("p-001")
    assert budget(gate)["reserved"] == 10_000


def test_cannot_cancel_unreserved_decision(gate, direct_vm):
    mock(direct_vm, "NON_COMPLIANT", url=WARNING)
    submit(gate, urls=(WARNING,))
    with direct_vm.expect_revert("no active reservation"):
        gate.cancel_authorization("p-001")
    with direct_vm.expect_revert("NOT_FOUND"):
        gate.cancel_authorization("missing-id")


def test_any_address_may_propose(gate, direct_vm, direct_bob):
    mock(direct_vm, "COMPLIANT")
    with direct_vm.prank(direct_bob):
        submit(gate)
    assert proposal(gate, "p-001")["proposer"] == direct_bob.as_hex.lower()


# ------------------------------------------------------------------ views

def test_listing_and_decision_views(gate, direct_vm):
    mock(direct_vm, "COMPLIANT")
    submit(gate, pid="a-1")
    mock(direct_vm, "NON_COMPLIANT", url=WARNING)
    submit(gate, pid="a-2", urls=(WARNING,))
    listing = json.loads(gate.list_proposals(0, 10))
    assert listing["total"] == 2 and [p["proposal_id"] for p in listing["items"]] == ["a-1", "a-2"]
    assert json.loads(gate.list_proposals(1, 10))["items"][0]["proposal_id"] == "a-2"
    decision = json.loads(gate.get_decision("a-2"))
    assert decision["status"] == "NON_COMPLIANT" and decision["reserved_amount"] == 0
    summary = json.loads(gate.get_summary())
    assert summary == {"proposals": 2, "compliant": 1, "non_compliant": 1, "insufficient_evidence": 0,
                       "cancelled": 0, "reserved": 10_000, "available": 90_000, "total_cap": 100_000}
    with direct_vm.expect_revert("pagination"):
        gate.list_proposals(0, 51)


# ---------------------------------------------------------------- ownership

def test_ownership_transfer_moves_cancellation_right(gate, direct_vm, direct_bob):
    mock(direct_vm, "COMPLIANT")
    submit(gate)
    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("FORBIDDEN"):
            gate.transfer_ownership(direct_bob.as_hex)
    gate.transfer_ownership(direct_bob.as_hex)
    assert json.loads(gate.get_mandate())["owner"] == direct_bob.as_hex.lower()
    with direct_vm.expect_revert("FORBIDDEN"):
        gate.cancel_authorization("p-001")
    with direct_vm.prank(direct_bob):
        gate.cancel_authorization("p-001")
    assert budget(gate)["reserved"] == 0


def test_ownership_transfer_validates_address(gate, direct_vm):
    with direct_vm.expect_revert("20-byte address"):
        gate.transfer_ownership("0x1234")


def test_validator_agrees_on_shared_llm_failure(gate, direct_vm):
    # Capture the validator for this proposal context with a successful round first.
    mock(direct_vm, "COMPLIANT")
    submit(gate)
    error = "[LLM_ERROR] model returned no usable structured assessment"
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"mandate-gate-azure.vercel.app", {"status": 200, "body": "record"})
    direct_vm.mock_llm(r"MANDATEGATE_ADJUDICATION", llm({"nonsense": True}))
    # Leader failed and this validator independently fails the same way: agree to revert.
    assert direct_vm.run_validator(leader_error=Exception(error)) is True
    # A validator that does obtain a usable assessment must not rubber-stamp the failure.
    mock(direct_vm, "COMPLIANT")
    assert direct_vm.run_validator(leader_error=Exception(error)) is False
