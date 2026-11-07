run "permission_names_resolve_within_their_scope" {
  command = plan

  variables {
    available = [
      { id = "scripts", name = "Workers Scripts Write", scopes = ["com.cloudflare.api.account"] },
      { id = "r2", name = "Workers R2 Storage Write", scopes = ["com.cloudflare.api.account"] },
      { id = "r2-bucket", name = "Workers R2 Storage Write", scopes = ["com.cloudflare.edge.r2.bucket"] },
      { id = "routes", name = "Workers Routes Write", scopes = ["com.cloudflare.api.account.zone"] },
      { id = "api-tokens", name = "Account API Tokens Write", scopes = ["com.cloudflare.api.account"] },
    ]
    required = {
      "com.cloudflare.api.account"      = ["Workers Scripts Write", "Workers R2 Storage Write"]
      "com.cloudflare.api.account.zone" = ["Workers Routes Write"]
    }
  }

  assert {
    condition = { for scope, ids in output.ids : scope => toset(ids) } == {
      "com.cloudflare.api.account"      = toset(["scripts", "r2"])
      "com.cloudflare.api.account.zone" = toset(["routes"])
    }
    error_message = "Each name must resolve to the one group of that name in its scope, and nothing else."
  }
}

run "unknown_permission_name_fails" {
  command = plan

  variables {
    available = [
      { id = "scripts", name = "Workers Scripts Write", scopes = ["com.cloudflare.api.account"] },
      { id = "dns", name = "DNS Write", scopes = ["com.cloudflare.api.account.zone"] },
    ]
    required = {
      "com.cloudflare.api.account" = ["Workers Scripts Write", "DNS Write"]
    }
  }

  expect_failures = [output.ids]
}
