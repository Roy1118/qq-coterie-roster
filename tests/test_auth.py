from __future__ import annotations

import unittest

from qqroster.auth import gtk, hash33, parse_cookie_header


class AuthHelpersTest(unittest.TestCase):
    def test_gtk_empty(self) -> None:
        self.assertEqual(gtk(""), 5381)

    def test_gtk_known(self) -> None:
        # 5381 + (5381 << 5) + ord('a') = 5381 + 172192 + 97
        self.assertEqual(gtk("a"), 177670)

    def test_hash33_empty(self) -> None:
        self.assertEqual(hash33(""), 0)

    def test_parse_cookie_header(self) -> None:
        parsed = parse_cookie_header("uin=o123; skey=@abc; p_skey=xyz")
        self.assertEqual(parsed["uin"], "o123")
        self.assertEqual(parsed["skey"], "@abc")
        self.assertEqual(parsed["p_skey"], "xyz")

    def test_parse_cookie_header_ignores_garbage(self) -> None:
        parsed = parse_cookie_header(" ; broken ; a=b ; ")
        self.assertEqual(parsed, {"a": "b"})


if __name__ == "__main__":
    unittest.main()
