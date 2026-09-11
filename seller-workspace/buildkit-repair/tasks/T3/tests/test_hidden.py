from buildkit.globmatch import match, select


def test_double_star_matches_zero_segments_in_the_middle():
    assert match("src/**/*.py", "src/main.py")
    assert match("a/**/b", "a/b")
    assert match("docs/**/index.md", "docs/index.md")


def test_leading_double_star_matches_top_level():
    assert match("**/test_*.py", "test_cli.py")
    assert match("**/test_*.py", "pkg/sub/test_cli.py")
    assert match("**/Makefile", "Makefile")


def test_several_double_star_segments():
    assert match("src/**/*.py", "src/a/b/c/d.py")
    assert match("a/**/b/**/c", "a/b/c")
    assert match("a/**/b/**/c", "a/x/b/y/z/c")
    assert match("**/**/x", "x")
    assert not match("a/**/b/**/c", "a/x/c")


def test_double_star_only_spans_whole_segments():
    assert not match("src/**/*.py", "srcx/main.py")
    assert not match("a/**/b", "a/xb")
    assert not match("a/**/b", "ab")
    assert not match("**/test_*.py", "pkg/mytest_x.py")
    assert match("a**b", "axyb")
    assert not match("a**b", "ax/yb")


def test_trailing_double_star():
    assert match("build/**", "build/x.o")
    assert match("build/**", "build/a/b/x.o")
    assert not match("build/**", "build")
    assert not match("build/**", "buildx/a")


def test_star_and_question_do_not_cross_slash():
    assert match("src/*.py", "src/a.py")
    assert not match("src/*.py", "src/pkg/a.py")
    assert match("?.txt", "a.txt")
    assert not match("a?b", "a/b")
    assert not match("*.py", "apy")


def test_character_classes():
    assert match("file[0-9].txt", "file7.txt")
    assert not match("file[0-9].txt", "filex.txt")
    assert match("[!.]*", "readme")
    assert not match("[!.]*", ".env")
    assert not match("a[!x]b", "a/b")
    assert match("[]]x", "]x")
    assert match("[!]]x", "ax") and not match("[!]]x", "]x")
    assert match("a[b", "a[b")


def test_literal_regex_characters():
    assert match("v1.2+build(3)/*.tar.gz", "v1.2+build(3)/pkg.tar.gz")
    assert not match("v1.2/*.tar.gz", "v1x2/pkg.tar.gz")


def test_select_with_zero_segment_patterns():
    paths = ["src/main.py", "src/pkg/util.py", "src/pkg/test_util.py", "test_top.py", "README.md", "build/out.py"]
    assert select(paths, ["src/**/*.py", "*.md"], ["**/test_*.py"]) == ["src/main.py", "src/pkg/util.py", "README.md"]
    assert select(paths, ["**/*.py"], ["**/test_*.py", "build/**"]) == ["src/main.py", "src/pkg/util.py"]
