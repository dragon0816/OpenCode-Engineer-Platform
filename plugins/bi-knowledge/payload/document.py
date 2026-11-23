"""BI document operations with explicit byte inputs and bounded results."""

import base64
import json


def process(operation, args, data, call):
    from catalog import project
    from convert import SOURCE_BYTES, ConversionError, convert
    from extract import plan
    from staging import card_identity


    def recognize(page, mime, image):
        return call("bi.ocr", page=page, mime=mime, base64=base64.b64encode(image).decode("ascii"))

    try:
        if len(data) > SOURCE_BYTES:
            raise ConversionError("limit")
        if operation == "convert":
            result = convert(args[0], data, args[1], recognize)
        elif operation == "plan":
            result = plan(json.loads(data))
        elif operation == "schema":
            result = [schema for path, document in json.loads(data) for schema in project(path, document)]
        elif operation == "identities":
            result = [card_identity(entity_type, name) for entity_type, name in json.loads(data)]
        else:
            raise ValueError("format")
        payload = {"result": result}
    except ConversionError as error:
        payload = {"error": str(error)}
    except UnicodeError:
        payload = {"error": "encoding"}
    except ValueError as error:
        payload = {"error": "limit" if str(error) == "limit" else "invalid"}
    except Exception:
        payload = {"error": "invalid"}
    return payload


def run(input):
    from oep_plugin import call, read_source

    return process(input["operation"], input["args"], read_source(input["source"]), call)
