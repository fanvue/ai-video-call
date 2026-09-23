# The persona allowlist fails closed on every malformed or unvouched entry. No GPU.
# Run: cd services/longlive && python -m unittest -v test_persona
import hashlib
import json
import os
import tempfile
import unittest

from persona import (
    add_registered,
    is_valid_persona_id,
    is_valid_persona_name,
    list_personas,
    registered_entry,
    resolve_persona,
)

GOOD = {
    "id": "synth-persona-01",
    "file": "synth-persona-01.jpg",
    "synthetic": True,
    "rightsHolder": "Fanvue",
    "addedBy": "engineer",
    "addedAt": "2026-09-23",
    "name": "Seed",
    "note": "Seed synthetic persona",
}


class PersonaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.image("synth-persona-01.jpg")

    def image(self, name, root=None):
        with open(os.path.join(root or self.root, name), "wb") as handle:
            handle.write(b"\xff\xd8\xff fake jpeg")

    def manifest(self, entries):
        with open(os.path.join(self.root, "manifest.json"), "w") as handle:
            handle.write(entries if isinstance(entries, str) else json.dumps(entries))

    def refused(self, entry_or_entries, persona_id="synth-persona-01"):
        self.manifest(entry_or_entries if isinstance(entry_or_entries, (list, str)) else [entry_or_entries])
        persona, reason = resolve_persona(self.root, persona_id)
        self.assertIsNone(persona)
        self.assertTrue(reason)
        return reason

    def test_a_complete_entry_resolves_to_its_file(self):
        self.manifest([GOOD])
        persona, reason = resolve_persona(self.root, "synth-persona-01")
        self.assertEqual(reason, "")
        self.assertEqual(persona.path, os.path.join(self.root, "synth-persona-01.jpg"))
        self.assertEqual(persona.note, "Seed synthetic persona")
        self.assertEqual(persona.name, "Seed")

    def test_entry_without_a_name_still_resolves(self):
        entry = {k: v for k, v in GOOD.items() if k != "name"}
        self.manifest([entry])
        persona, reason = resolve_persona(self.root, "synth-persona-01")
        self.assertEqual(reason, "")
        self.assertEqual(persona.name, "")

    def test_unknown_id_is_refused(self):
        self.manifest([GOOD])
        self.assertIn("not in manifest", resolve_persona(self.root, "someone-else")[1])

    def test_missing_file_is_refused(self):
        self.assertIn("file missing", self.refused({**GOOD, "file": "gone.jpg"}))

    def test_synthetic_must_be_literally_true(self):
        for value in [None, False, "true", 1]:
            entry = {k: v for k, v in GOOD.items() if k != "synthetic"} if value is None else {**GOOD, "synthetic": value}
            self.assertIn("not marked synthetic", self.refused(entry))

    def test_rights_holder_is_required(self):
        for value in [None, "", "   ", 7]:
            entry = {k: v for k, v in GOOD.items() if k != "rightsHolder"} if value is None else {**GOOD, "rightsHolder": value}
            self.assertIn("no rightsHolder", self.refused(entry))

    def test_file_must_be_a_bare_image_name_inside_the_volume(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        self.image("elsewhere.jpg", outside.name)
        os.symlink(os.path.join(outside.name, "elsewhere.jpg"), os.path.join(self.root, "link.jpg"))
        for name in ["../synth-persona-01.jpg", "sub/synth-persona-01.jpg", "/etc/passwd", ".hidden.jpg", "notes.txt", "", 3]:
            self.refused({**GOOD, "file": name})
        self.assertIn("outside the persona volume", self.refused({**GOOD, "file": "link.jpg"}))

    def test_malformed_manifests_are_refused(self):
        self.assertIn("manifest unreadable", resolve_persona(self.root, "synth-persona-01")[1])
        for broken in ["{not json", json.dumps({"id": "synth-persona-01"}), json.dumps("x")]:
            self.assertIn("manifest unreadable", self.refused(broken))

    def test_duplicate_ids_trust_neither(self):
        self.assertIn("duplicate", self.refused([GOOD, {**GOOD, "note": "second"}]))

    def test_invalid_ids_never_reach_the_manifest(self):
        self.manifest([GOOD])
        for value in [None, "", "UPPER", "a b", "a_b", "../x", "x" * 65, "abc\n", 5]:
            self.assertEqual(resolve_persona(self.root, value), (None, "invalid persona id"))

    def test_listing_shows_only_ids_notes_names_and_addedat_of_resolvable_entries(self):
        self.manifest([GOOD, {**GOOD, "id": "no-rights", "rightsHolder": ""}, {**GOOD, "id": "no-file", "file": "x.jpg"}])
        self.assertEqual(
            list_personas(self.root),
            [{"id": "synth-persona-01", "note": "Seed synthetic persona", "name": "Seed", "addedAt": "2026-09-23"}],
        )
        os.remove(os.path.join(self.root, "manifest.json"))
        self.assertEqual(list_personas(self.root), [])

    def test_listing_falls_back_to_an_empty_name_for_an_old_entry(self):
        entry = {k: v for k, v in GOOD.items() if k != "name"}
        self.manifest([entry])
        self.assertEqual(
            list_personas(self.root),
            [{"id": "synth-persona-01", "note": "Seed synthetic persona", "name": "", "addedAt": "2026-09-23"}],
        )


class PersonaIdTest(unittest.TestCase):
    def test_shape(self):
        for value in ["synth-persona-01", "a", "0-9", "x" * 64]:
            self.assertTrue(is_valid_persona_id(value), value)
        for value in ["", "x" * 65, "Synth", "a.b", "a/b", "a\n", " a", None, 1, ["a"]]:
            self.assertFalse(is_valid_persona_id(value), value)


class PersonaNameTest(unittest.TestCase):
    def test_shape(self):
        for value in ["Ava", "a", "Ava-Jane_02.5 O'Brien", "x" * 40]:
            self.assertTrue(is_valid_persona_name(value), value)
        for value in ["", "x" * 41, "Ava\n", None, 1, ["a"]]:
            self.assertFalse(is_valid_persona_name(value), value)


class RegisteredEntryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.image = b"\xff\xd8\xff uploaded"
        self.sha = hashlib.sha256(self.image).hexdigest()

    def test_entry_has_every_field_and_a_hash_derived_id(self):
        entry = registered_entry(self.sha, ".jpg", "user-uuid-1", "2026-09-23T12:00:00+00:00", "Ava")
        self.assertEqual(entry["id"], f"upload-{self.sha[:12]}")
        self.assertEqual(entry["file"], f"upload-{self.sha[:12]}.jpg")
        self.assertIs(entry["synthetic"], True)
        self.assertIs(entry["attested"], True)
        self.assertEqual(entry["rightsHolder"], "Fanvue")
        self.assertEqual(entry["addedBy"], "user-uuid-1")
        self.assertEqual(entry["addedAt"], "2026-09-23T12:00:00+00:00")
        self.assertEqual(entry["sha256"], self.sha)
        self.assertEqual(entry["name"], "Ava")
        self.assertTrue(entry["note"])
        self.assertEqual(
            entry, registered_entry(self.sha, ".jpg", "user-uuid-1", "2026-09-23T12:00:00+00:00", "Ava")
        )

    def test_bad_hash_or_extension_is_rejected(self):
        for sha in ["", "ABC" * 21 + "D", self.sha[:-1], self.sha.upper()]:
            with self.assertRaises(ValueError):
                registered_entry(sha, ".jpg", "u", "t", "Ava")
        with self.assertRaises(ValueError):
            registered_entry(self.sha, ".gif", "u", "t", "Ava")

    def test_bad_name_is_rejected(self):
        for name in ["", "   ", "x" * 41, "Ava\n", "Ava/2", None, 7]:
            with self.assertRaises(ValueError):
                registered_entry(self.sha, ".jpg", "u", "t", name)

    def test_registered_upload_resolves_and_other_ids_stay_refused(self):
        entry = registered_entry(self.sha, ".jpg", "user-uuid-1", "t", "Ava")
        self.assertTrue(add_registered(self.tmp.name, entry, self.image))
        self.assertFalse(add_registered(self.tmp.name, entry, self.image))
        persona, reason = resolve_persona(self.tmp.name, entry["id"])
        self.assertEqual(reason, "")
        self.assertEqual(persona.name, "Ava")
        with open(persona.path, "rb") as handle:
            self.assertEqual(handle.read(), self.image)
        self.assertIsNone(resolve_persona(self.tmp.name, "upload-000000000000")[0])
        with open(os.path.join(self.tmp.name, "manifest.json")) as handle:
            self.assertEqual(len(json.load(handle)), 1)


if __name__ == "__main__":
    unittest.main()
