import os
import socket
import time
from pathlib import Path


def run(input):
    from example_support import as_quote
    from oep_plugin import BrokerError, call, progress, read_source, write_data

    def denied(operation, error):
        try:
            operation()
        except error:
            return True
        return False

    if input.get("mode") == "hang":
        write_data("worker.pid", str(os.getpid()).encode("ascii"))
        progress(35)
        time.sleep(60)
        return {}
    if input.get("mode") == "probe":
        def connect():
            with socket.socket() as connection:
                connection.settimeout(1)
                connection.connect(("127.0.0.1", input["port"]))

        return {
            "privateReadDenied": denied(lambda: Path(input["private"]).read_text(), PermissionError),
            "privateWriteDenied": denied(lambda: Path(input["outside"]).write_text("outside"), PermissionError),
            "packageWriteDenied": denied(lambda: Path(__file__).with_name("unexpected.txt").touch(), PermissionError),
            "networkDenied": denied(connect, PermissionError),
            "gatewayKeyAbsent": not any(name.endswith(("API_KEY", "TOKEN")) for name in os.environ),
            "sourceDenied": denied(lambda: read_source(input["missing"]), BrokerError),
            "publishDenied": denied(lambda: call("publish.request", id=input["missing"]), BrokerError),
        }
    sources = call("sources.list")
    if not sources:
        return {"records": 0}
    progress(25)
    source = sources[0]["id"]
    original = read_source(source)
    quote = as_quote(original)
    write_data("last-input.txt", original)
    progress(65)
    if input.get("draft"):
        if input.get("badEvidence"):
            quote = "fabricated evidence"
        card = {
            "title": "Synthetic measurement", "fields": {"measurement": {"value": quote, "quote": quote}}
        }
        if input.get("model"):
            response = call("models.complete", prompt="Return the selected synthetic fact.", input={"source": quote})
            assert response["content"] == "Synthetic model receipt"
        cards = [card, {**card, "title": "Second synthetic measurement"}] if input.get("multiple") else [card]
        call("reviews.propose", draft=input["draft"], source=source,
             proposal={"cards": cards} if input.get("multiple") else card)
    return {"records": 2 if input.get("multiple") else 1}
