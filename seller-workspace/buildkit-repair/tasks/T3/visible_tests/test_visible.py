from buildkit.globmatch import match


def test_double_star_matches_files_directly_under_src():
    assert match("src/**/*.py", "src/main.py")


def test_star_does_not_cross_directories():
    assert match("src/*.py", "src/main.py")
    assert not match("src/*.py", "src/pkg/util.py")
