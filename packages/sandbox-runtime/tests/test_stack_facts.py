"""What the scanner sees in a tree, independent of any policy."""

import json
from pathlib import PurePosixPath

import pytest

from sandbox_runtime import stack_facts
from sandbox_runtime.stack_facts import (
    ECOSYSTEMS,
    STACK_CONTRACT,
    CommitSource,
    DirectorySource,
    WorktreeSource,
    collect_tree_facts,
    counts_as_source,
    derived_paths,
)
from sandbox_runtime.stack_policy import Signal
from tests.stack_fixtures import add_submodule, commit, git, init_repo, package_json, write

GOLDEN = STACK_CONTRACT["golden"]


def declared(facts) -> set[tuple[str, str, str, str]]:
    return {(d.ecosystem, d.name, str(d.manifest_path), d.scope) for d in facts.declared}


def test_ecosystem_registry_equals_the_contract():
    assert set(ECOSYSTEMS) == set(STACK_CONTRACT["ecosystems"])


@pytest.mark.parametrize("case", GOLDEN["normalization"])
def test_golden_normalization(case):
    assert ECOSYSTEMS[case["ecosystem"]].normalize(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", GOLDEN["packageSignal"])
def test_golden_package_signal(case):
    assert Signal("package", "npm", case["signal"]).matches(case["name"]) is case["matches"]


@pytest.mark.parametrize("case", GOLDEN["fileGlob"])
def test_golden_file_glob(case):
    assert Signal("file", "", case["pattern"]).matches(case["basename"]) is case["matches"]


@pytest.mark.parametrize("case", GOLDEN["sourceExclusion"])
def test_golden_source_exclusion(case):
    assert counts_as_source(PurePosixPath(case["path"])) is case["counted"]


@pytest.mark.parametrize("case", GOLDEN["derived"])
def test_golden_derived_files(case):
    path = PurePosixPath(case["path"])
    listed = [path, *(PurePosixPath(sibling) for sibling in case["siblings"])]
    assert (path in derived_paths(listed)) is case["derived"]


async def test_npm_fields_map_to_scopes_and_an_alias_matches_the_installed_package(tmp_path):
    write(
        tmp_path,
        {
            "package.json": json.dumps(
                {
                    "dependencies": {"Svelte": "^5", "ui": "npm:react@^18"},
                    "devDependencies": {"vite": "^6"},
                    "peerDependencies": {"@Acme/UI": "*"},
                    "optionalDependencies": {"fsevents": "^2"},
                }
            )
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert declared(facts) == {
        ("npm", "svelte", "package.json", "runtime"),
        ("npm", "react", "package.json", "runtime"),
        ("npm", "vite", "package.json", "dev"),
        ("npm", "@acme/ui", "package.json", "peer"),
        ("npm", "fsevents", "package.json", "optional"),
    }
    assert facts.complete


async def test_workspace_manifests_are_found_and_node_modules_is_skipped(tmp_path):
    init_repo(
        tmp_path,
        {
            "package.json": json.dumps({"workspaces": ["packages/*"]}),
            "packages/web/package.json": package_json(svelte="^5"),
            ".gitignore": "node_modules/\n",
        },
    )
    write(tmp_path, {"node_modules/react/package.json": package_json(scheduler="1")})
    git(tmp_path, "add", "-f", "node_modules/react/package.json")

    facts = await collect_tree_facts(WorktreeSource(tmp_path))

    assert declared(facts) == {("npm", "svelte", "packages/web/package.json", "runtime")}


async def test_an_unparseable_manifest_makes_the_facts_incomplete(tmp_path):
    write(tmp_path, {"web/package.json": "{ not json", "api/package.json": package_json(hono="4")})

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert facts.unreadable == (PurePosixPath("web/package.json"),)
    assert not facts.complete
    assert declared(facts) == {("npm", "hono", "api/package.json", "runtime")}


async def test_npm_lockfiles_give_resolved_versions_and_direct_flags(tmp_path):
    write(
        tmp_path,
        {
            "web/package.json": package_json(react="^18"),
            "web/package-lock.json": json.dumps(
                {
                    "lockfileVersion": 3,
                    "packages": {
                        "": {"dependencies": {"react": "^18"}},
                        "node_modules/react": {"version": "18.3.1"},
                        "node_modules/loose-envify": {"version": "1.4.0"},
                        "node_modules/local": {"link": True},
                    },
                }
            ),
            "app/package.json": package_json(svelte="^5"),
            # bun.lock is JSONC: trailing commas are legal.
            "app/bun.lock": (
                '{\n  "lockfileVersion": 1,\n  "packages": {\n'
                '    "svelte": ["svelte@5.1.0", "", {}, "sha512-x"],\n'
                '    "esm-env": ["esm-env@1.2.0", "", {}, "sha512-y"],\n  },\n}\n'
            ),
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert {(r.name, r.version, str(r.lockfile_path), r.direct) for r in facts.resolved} == {
        ("react", "18.3.1", "web/package-lock.json", True),
        ("loose-envify", "1.4.0", "web/package-lock.json", False),
        ("svelte", "5.1.0", "app/bun.lock", True),
        ("esm-env", "1.2.0", "app/bun.lock", False),
    }


async def test_python_manifests_and_includes(tmp_path):
    write(
        tmp_path,
        {
            "pyproject.toml": (
                "[project]\n"
                'dependencies = ["Django>=4", "zope.interface"]\n'
                '[project.optional-dependencies]\ntest = ["pytest"]\n'
                '[dependency-groups]\nlint = ["ruff", {include-group = "test"}]\n'
                '[tool.poetry.dependencies]\npython = "^3.12"\nrequests = "^2"\n'
            ),
            "svc/requirements.txt": (
                "# runtime\n"
                "Flask[async]>=2 ; python_version > '3.8'\n"
                "-r common/base.in\n"
                "-e git+https://example.com/acme/tool.git#egg=Acme_Tool\n"
                "--index-url https://pypi.example.com/simple\n"
            ),
            "svc/common/base.in": "Typing_Extensions==4.12\n",
            "Pipfile": '[packages]\nnumpy = "*"\n[dev-packages]\nblack = "*"\n',
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert declared(facts) == {
        ("pypi", "django", "pyproject.toml", "runtime"),
        ("pypi", "zope-interface", "pyproject.toml", "runtime"),
        ("pypi", "pytest", "pyproject.toml", "optional"),
        ("pypi", "ruff", "pyproject.toml", "dev"),
        ("pypi", "requests", "pyproject.toml", "runtime"),
        ("pypi", "flask", "svc/requirements.txt", "runtime"),
        ("pypi", "acme-tool", "svc/requirements.txt", "runtime"),
        ("pypi", "typing-extensions", "svc/common/base.in", "runtime"),
        ("pypi", "numpy", "Pipfile", "runtime"),
        ("pypi", "black", "Pipfile", "dev"),
    }
    flask = next(d for d in facts.declared if d.name == "flask")
    assert flask.declared_range == ">=2"


async def test_python_lockfiles_give_resolved_versions(tmp_path):
    write(
        tmp_path,
        {
            "pyproject.toml": '[project]\ndependencies = ["httpx"]\n',
            "uv.lock": (
                '[[package]]\nname = "httpx"\nversion = "0.28.1"\n'
                '[[package]]\nname = "h11"\nversion = "0.16.0"\n'
            ),
            "legacy/poetry.lock": '[[package]]\nname = "Django"\nversion = "4.2.0"\n',
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert {(r.name, r.version, r.direct) for r in facts.resolved} == {
        ("httpx", "0.28.1", True),
        ("h11", "0.16.0", False),
        ("django", "4.2.0", False),
    }


async def test_a_requirements_file_exported_beside_uv_lock_is_derived_not_declared(tmp_path):
    write(
        tmp_path,
        {
            "svc/uv.lock": "version = 1\n",
            "svc/requirements.txt": "httpx==0.28.1\nh11==0.16.0\n",
            "tools/requirements.txt": "black\n",
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert facts.derived == frozenset({PurePosixPath("svc/requirements.txt")})
    assert declared(facts) == {("pypi", "black", "tools/requirements.txt", "runtime")}


async def test_worktree_source_lists_force_added_and_untracked_files_but_not_ignored_or_deleted(
    tmp_path,
):
    init_repo(tmp_path, {".gitignore": "vendor/\n", "gone.txt": "tracked\n"})
    write(
        tmp_path,
        {
            "vendor/forced/package.json": package_json(react="18"),
            "vendor/ignored/package.json": package_json(next="15"),
            "new/package.json": package_json(svelte="5"),
        },
    )
    git(tmp_path, "add", "-f", "vendor/forced/package.json")
    (tmp_path / "gone.txt").unlink()

    paths = set(await WorktreeSource(tmp_path).list_paths())

    assert PurePosixPath("vendor/forced/package.json") in paths
    assert PurePosixPath("new/package.json") in paths
    assert PurePosixPath("vendor/ignored/package.json") not in paths
    assert PurePosixPath("gone.txt") not in paths


async def test_commit_source_reads_the_commit_not_the_worktree(tmp_path):
    head = init_repo(tmp_path, {"package.json": package_json(svelte="5")})
    write(tmp_path, {"package.json": package_json(react="18"), "extra/bun.lock": "{}"})

    committed = await collect_tree_facts(CommitSource(tmp_path, head))
    worktree = await collect_tree_facts(WorktreeSource(tmp_path))

    assert declared(committed) == {("npm", "svelte", "package.json", "runtime")}
    assert PurePosixPath("extra/bun.lock") not in committed.paths
    assert declared(worktree) == {("npm", "react", "package.json", "runtime")}


async def test_directory_source_prunes_dependency_build_and_hidden_directories(tmp_path):
    write(
        tmp_path,
        {
            "app/package.json": package_json(svelte="5"),
            "app/node_modules/react/package.json": package_json(),
            "app/dist/bundle.js": "",
            ".opencode/tool/x.js": "",
            ".opencode/package.json": package_json(zod="3"),
        },
    )

    paths = await DirectorySource(tmp_path).list_paths()

    assert paths == [PurePosixPath("app/package.json")]


async def test_app_manifest_declares_data_stores_and_a_broken_one_is_unreadable(tmp_path):
    write(
        tmp_path,
        {
            "tracker/openinspect.app.json": json.dumps(
                {
                    "schemaVersion": 1,
                    "name": "tracker",
                    "data": {
                        "DB": {"kind": "d1"},
                        "FILES": {"kind": "r2"},
                        "X": {"kind": "external"},
                    },
                }
            ),
            "broken/openinspect.app.json": "{",
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert {(str(s.path), s.kind) for s in facts.data_stores} == {
        ("tracker/openinspect.app.json", "d1"),
        ("tracker/openinspect.app.json", "r2"),
    }
    assert facts.unreadable == (PurePosixPath("broken/openinspect.app.json"),)


async def test_oversize_and_symlinked_manifests_are_unreadable_never_followed(
    tmp_path, monkeypatch
):
    outside = tmp_path / "outside.json"
    outside.write_text(package_json(react="18"))
    repo = tmp_path / "repo"
    write(repo, {"big/package.json": package_json(svelte="5" * 200)})
    (repo / "linked").mkdir()
    (repo / "linked" / "package.json").symlink_to(outside)
    monkeypatch.setattr(stack_facts, "MAX_MANIFEST_BYTES", 100)

    facts = await collect_tree_facts(DirectorySource(repo))

    assert set(facts.unreadable) == {
        PurePosixPath("big/package.json"),
        PurePosixPath("linked/package.json"),
    }
    assert facts.declared == ()


async def test_sources_are_bucketed_by_extension_after_platform_exclusions(tmp_path):
    write(
        tmp_path,
        {
            "src/b.ts": "",
            "src/a.ts": "",
            "src/routes/+page.js": "",
            "svelte.config.js": "",
            ".eslintrc.cjs": "",
            "build/out.js": "",
            "src/App.svelte": "",
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert dict(facts.sources) == {
        ".js": (PurePosixPath("src/routes/+page.js"),),
        ".svelte": (PurePosixPath("src/App.svelte"),),
        ".ts": (PurePosixPath("src/a.ts"), PurePosixPath("src/b.ts")),
    }


async def test_project_directories_are_those_holding_toolchain_files(tmp_path):
    write(
        tmp_path,
        {
            "web/package.json": package_json(),
            "svc/uv.lock": "",
            "svc/requirements.txt": "",
            "docs/readme.md": "",
        },
    )

    facts = await collect_tree_facts(DirectorySource(tmp_path))

    assert facts.project_dirs == frozenset({PurePosixPath("web"), PurePosixPath("svc")})


async def test_commit_source_lists_only_blobs_of_that_revision(tmp_path):
    first = init_repo(tmp_path, {"a/package.json": package_json()})
    commit(tmp_path, {"b/package.json": package_json()})

    assert await CommitSource(tmp_path, first).list_paths() == [PurePosixPath("a/package.json")]


async def test_submodules_and_nested_repositories_make_the_facts_incomplete(tmp_path):
    repo = tmp_path / "repo"
    init_repo(repo)
    add_submodule(repo, "vendor/ui")
    head = commit(repo, {}, "add submodule")
    init_repo(repo / "cloned")

    committed = await collect_tree_facts(CommitSource(repo, head))
    worktree = await collect_tree_facts(WorktreeSource(repo))

    assert committed.submodules == (PurePosixPath("vendor/ui"),)
    assert worktree.submodules == (PurePosixPath("cloned"), PurePosixPath("vendor/ui"))
    assert not committed.complete
    assert not worktree.complete
    assert declared(committed) == declared(worktree) == set()
    assert PurePosixPath("vendor/ui") not in committed.paths + worktree.paths
