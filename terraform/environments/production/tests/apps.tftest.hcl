mock_provider "cloudflare" {}

mock_provider "cloudflare" {
  alias           = "apps"
  override_during = plan

  override_resource {
    target = cloudflare_zero_trust_access_policy.app_visitors
    values = { id = "visitor-policy" }
  }

  override_resource {
    target = cloudflare_zero_trust_access_policy.broker_service
    values = { id = "broker-service-policy" }
  }

  override_resource {
    target = cloudflare_zero_trust_access_application.apps_floor
    values = { id = "floor-app" }
  }

  override_resource {
    target = cloudflare_zero_trust_access_service_token.control_plane
    values = {
      id            = "control-plane-token"
      client_id     = "control-plane-client.access"
      client_secret = "control-plane-client-secret"
    }
  }

  override_resource {
    target = cloudflare_account_token.app_broker
    values = { value = "minted-broker-token" }
  }
}

override_module {
  target          = module.apps_broker_permissions
  override_during = plan
  outputs = {
    ids = {
      "com.cloudflare.api.account"      = ["scripts", "access", "d1", "kv", "r2"]
      "com.cloudflare.api.account.zone" = ["routes", "dns"]
    }
  }
}

mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "test-source-hash"
      }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "apps-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform          = "cloudflare"
  cf_access_team_domain = "https://test-team.cloudflareaccess.com"
  cf_access_aud         = "test-openinspect-audience"
  project_root          = "../../../"
  enable_github_bot     = false
  enable_slack_bot      = false
  enable_linear_bot     = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "disabled_apps_add_nothing" {
  command = plan

  assert {
    condition = (
      length(cloudflare_zero_trust_access_policy.app_visitors) == 0 &&
      length(cloudflare_zero_trust_access_application.apps_floor) == 0 &&
      length(cloudflare_zero_trust_access_service_token.control_plane) == 0 &&
      length(cloudflare_zero_trust_access_application.broker) == 0 &&
      length(data.cloudflare_account_api_token_permission_groups_list.apps) == 0 &&
      length(cloudflare_account_token.app_broker) == 0 &&
      length(cloudflare_workers_for_platforms_dispatch_namespace.apps) == 0 &&
      length(module.app_broker) == 0 &&
      length(module.apps_dispatcher) == 0 &&
      length(null_resource.app_broker_build) == 0 &&
      length(random_password.service_auth_secret_app_broker) == 0 &&
      length(terraform_data.apps_domain_gate) == 0
    )
    error_message = "Without apps_enabled, Terraform must plan nothing in the apps account."
  }

  assert {
    condition = length(setintersection(
      toset(concat(module.control_plane_worker.plain_text_binding_names, module.control_plane_worker.secret_binding_names)),
      ["APP_BROKER_URL", "APPS_DOMAIN", "APP_BROKER_ACCESS_CLIENT_ID", "APP_DATA_JURISDICTION", "SERVICE_AUTH_SECRET_APP_BROKER", "APP_BROKER_ACCESS_CLIENT_SECRET"]
    )) == 0
    error_message = "Without apps_enabled, the control plane must receive no app hosting binding, so hosting stays off."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["SANDBOX_TUNNELS_POLICY"] == "public"
    error_message = "Sandbox preview tunnels must stay public by default."
  }
}

run "workers_backend" {
  command = plan

  variables {
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "acme-apps.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
    app_data_jurisdiction      = "eu"
    sandbox_tunnels_policy     = "disabled"
  }

  assert {
    condition = (
      one(cloudflare_zero_trust_access_policy.app_visitors[0].include).email_domain.domain == "corp.example" &&
      cloudflare_zero_trust_access_policy.app_visitors[0].decision == "allow" &&
      cloudflare_zero_trust_access_policy.app_visitors[0].require == null
    )
    error_message = "The visitor policy must admit exactly the security-owned include rules."
  }

  assert {
    condition = (
      cloudflare_zero_trust_access_application.apps_floor[0].type == "self_hosted" &&
      cloudflare_zero_trust_access_application.apps_floor[0].destinations[0].uri == "*.acme-apps.example" &&
      length(cloudflare_zero_trust_access_application.apps_floor[0].policies) == 1 &&
      cloudflare_zero_trust_access_application.apps_floor[0].policies[0].id == "visitor-policy"
    )
    error_message = "Every hostname under the apps domain must be gated by the visitor policy alone."
  }

  assert {
    condition = (
      cloudflare_zero_trust_access_application.broker[0].destinations[0].uri == "deployer.acme-apps.example" &&
      length(cloudflare_zero_trust_access_application.broker[0].policies) == 1 &&
      cloudflare_zero_trust_access_application.broker[0].policies[0].id == "broker-service-policy" &&
      cloudflare_zero_trust_access_application.broker[0].service_auth_401_redirect == true &&
      cloudflare_zero_trust_access_policy.broker_service[0].decision == "non_identity" &&
      one(cloudflare_zero_trust_access_policy.broker_service[0].include).service_token.token_id == "control-plane-token"
    )
    error_message = "The broker hostname must admit only the control plane's service token."
  }

  assert {
    condition = (
      module.app_broker[0].subdomain.enabled == false &&
      module.app_broker[0].subdomain.previews_enabled == false &&
      module.app_broker[0].worker_url == null &&
      module.app_broker[0].custom_domain == "deployer.acme-apps.example"
    )
    error_message = "The broker must be reachable only at its Access-gated custom domain."
  }

  assert {
    condition = toset([
      for policy in cloudflare_account_token.app_broker[0].policies : jsonencode({
        effect    = policy.effect
        resources = jsondecode(policy.resources)
        groups    = sort([for group in policy.permission_groups : group.id])
      })
      ]) == toset([
      jsonencode({
        effect    = "allow"
        resources = { "com.cloudflare.api.account.0123456789abcdef0123456789abcdef" = "*" }
        groups    = ["access", "d1", "kv", "r2", "scripts"]
      }),
      jsonencode({
        effect    = "allow"
        resources = { "com.cloudflare.api.account.zone.fedcba9876543210fedcba9876543210" = "*" }
        groups    = ["dns", "routes"]
      }),
    ])
    error_message = "The broker token must hold exactly the Workers, Access, D1, KV and R2 account groups and the zone's route and DNS groups."
  }

  assert {
    condition = module.app_broker[0].plain_text_bindings == {
      APPS_ACCOUNT_ID          = "0123456789abcdef0123456789abcdef"
      APPS_ZONE_ID             = "fedcba9876543210fedcba9876543210"
      APPS_DOMAIN              = "acme-apps.example"
      APPS_SCRIPT_PREFIX       = "app-"
      APPS_HOSTING_BACKEND     = "workers"
      APPS_ACCESS_TEAM_DOMAIN  = "https://acme-apps.cloudflareaccess.com"
      APPS_ACCESS_POLICY_ID    = "visitor-policy"
      APPS_ACCESS_FLOOR_APP_ID = "floor-app"
      APP_DATA_JURISDICTION    = "eu"
    }
    error_message = "The broker must receive the apps account, domain, backend and Terraform-owned Access objects."
  }

  assert {
    condition     = toset(module.app_broker[0].secret_binding_names) == toset(["APPS_API_TOKEN", "SERVICE_AUTH_SECRET_CONTROL_PLANE"])
    error_message = "The broker must hold the minted apps token and the control plane's sig1 key, and no other secret."
  }

  assert {
    condition = (
      length(cloudflare_workers_for_platforms_dispatch_namespace.apps) == 0 &&
      length(module.apps_dispatcher) == 0
    )
    error_message = "The workers backend must not create a dispatch namespace or dispatcher."
  }

  assert {
    condition = (
      module.control_plane_worker.plain_text_bindings["APP_BROKER_URL"] == "https://deployer.acme-apps.example" &&
      module.control_plane_worker.plain_text_bindings["APPS_DOMAIN"] == "acme-apps.example" &&
      module.control_plane_worker.plain_text_bindings["APP_BROKER_ACCESS_CLIENT_ID"] == "control-plane-client.access" &&
      module.control_plane_worker.plain_text_bindings["APP_DATA_JURISDICTION"] == "eu" &&
      module.control_plane_worker.plain_text_bindings["SANDBOX_TUNNELS_POLICY"] == "disabled" &&
      contains(module.control_plane_worker.secret_binding_names, "SERVICE_AUTH_SECRET_APP_BROKER") &&
      contains(module.control_plane_worker.secret_binding_names, "APP_BROKER_ACCESS_CLIENT_SECRET")
    )
    error_message = "The control plane must learn the broker URL, apps domain, jurisdiction, tunnels policy, sig1 key and Access service token."
  }

  assert {
    condition     = length([for name in module.control_plane_worker.secret_binding_names : name if startswith(name, "APPS_")]) == 0
    error_message = "The control plane must never receive an apps-account API token."
  }
}

run "dispatch_namespace_backend" {
  command = plan

  variables {
    apps_enabled               = true
    apps_hosting_backend       = "dispatch-namespace"
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "acme-apps.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ group = { id = "workforce-group" } }, { email = { email = "contractor@partner.example" } }]
    apps_access_require        = [{ email_domain = { domain = "corp.example" } }]
  }

  assert {
    condition = (
      cloudflare_workers_for_platforms_dispatch_namespace.apps[0].name == "open-inspect-apps-apps-test" &&
      module.apps_dispatcher[0].dispatch_namespace_bindings == { DISPATCHER = "open-inspect-apps-apps-test" } &&
      module.apps_dispatcher[0].plain_text_bindings == { APPS_DOMAIN = "acme-apps.example", APPS_SCRIPT_PREFIX = "app-" } &&
      length(module.apps_dispatcher[0].secret_binding_names) == 0
    )
    error_message = "The dispatcher must route into the namespace by the apps domain and script prefix, holding no secret."
  }

  assert {
    condition = (
      module.apps_dispatcher[0].subdomain.enabled == false &&
      module.apps_dispatcher[0].subdomain.previews_enabled == false &&
      module.apps_dispatcher[0].custom_domain == null
    )
    error_message = "The dispatcher must have no ingress of its own: workers.dev and previews off, no Terraform domain."
  }

  assert {
    condition = (
      module.app_broker[0].plain_text_bindings["APPS_HOSTING_BACKEND"] == "dispatch-namespace" &&
      module.app_broker[0].plain_text_bindings["APPS_DISPATCH_NAMESPACE"] == "open-inspect-apps-apps-test" &&
      module.app_broker[0].plain_text_bindings["APPS_DISPATCHER_SERVICE"] == "open-inspect-app-dispatcher-apps-test"
    )
    error_message = "The broker must publish into the namespace and attach app hostnames to the dispatcher."
  }

  assert {
    condition = (
      toset([for rule in cloudflare_zero_trust_access_policy.app_visitors[0].include : coalesce(try(rule.group.id, null), try(rule.email.email, null))]) == toset(["workforce-group", "contractor@partner.example"]) &&
      one(cloudflare_zero_trust_access_policy.app_visitors[0].require).email_domain.domain == "corp.example"
    )
    error_message = "The visitor policy must carry the configured include and require rules."
  }

  assert {
    condition = toset(concat(
      keys(module.app_broker[0].plain_text_bindings),
      module.app_broker[0].secret_binding_names,
      )) == toset([
      for match in regexall("\n  ([A-Z_]+)\\?: string;", file("${var.project_root}packages/app-broker/src/env.ts")) : match[0]
    ])
    error_message = "Terraform must bind exactly the variables the broker reads (BrokerEnv in packages/app-broker/src/env.ts)."
  }

  assert {
    condition = toset(concat(
      keys(module.apps_dispatcher[0].plain_text_bindings),
      keys(module.apps_dispatcher[0].dispatch_namespace_bindings),
      )) == toset([
      for match in regexall("\n  ([A-Z_]+)\\??: [A-Za-z ]+;", regex("interface DispatcherEnv \\{([^}]*)\\}", file("${var.project_root}packages/app-broker/dispatcher/dispatcher.ts"))[0]) : match[0]
    ])
    error_message = "Terraform must bind exactly the variables the dispatcher reads (DispatcherEnv in packages/app-broker/dispatcher/dispatcher.ts)."
  }
}

run "apps_constants_match_the_broker" {
  command = plan

  assert {
    condition     = local.apps_broker_host == "deployer.${var.apps_domain}" && regex("APP_BROKER_HOST_LABEL = \"([a-z-]+)\"", file("${var.project_root}packages/shared/src/app-broker.ts"))[0] == "deployer"
    error_message = "The broker hostname label must match APP_BROKER_HOST_LABEL in packages/shared/src/app-broker.ts."
  }

  assert {
    condition     = startswith(local.apps_script_prefix, regex("APP_RESOURCE_PREFIX = \"([a-z-]+)\"", file("${var.project_root}packages/shared/src/app-broker.ts"))[0])
    error_message = "APPS_SCRIPT_PREFIX must start with APP_RESOURCE_PREFIX, or the broker refuses its configuration."
  }

  assert {
    condition     = local.apps_compatibility_date == regex("APP_SCRIPT_COMPATIBILITY_DATE = \"([0-9-]+)\"", file("${var.project_root}packages/app-broker/src/backends.ts"))[0]
    error_message = "The broker and dispatcher must run on the compatibility date the broker gives app scripts."
  }

  assert {
    condition = [
      for match in regexall("\"([a-z]+)\"", regex("DATA_JURISDICTIONS = \\[([^\\]]*)\\]", file("${var.project_root}packages/shared/src/types/app-data.ts"))[0]) : match[0]
    ] == ["eu", "fedramp"]
    error_message = "The broker's jurisdictions changed; update the app_data_jurisdiction validation to accept exactly them and ''."
  }
}

run "enabled_without_domain_fails" {
  command = plan

  variables {
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
  }

  expect_failures = [var.apps_domain]
}

run "enabled_without_zone_fails" {
  command = plan

  variables {
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_domain                = "acme-apps.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
  }

  expect_failures = [var.apps_zone_id]
}

run "enabled_without_visitor_rules_fails" {
  command = plan

  variables {
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "acme-apps.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
  }

  expect_failures = [var.apps_access_include]
}

run "enabled_without_team_domain_fails" {
  command = plan

  variables {
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "acme-apps.example"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
  }

  expect_failures = [var.apps_access_team_domain]
}

run "platform_token_for_apps_fails" {
  command = plan

  variables {
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-cloudflare-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "acme-apps.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
  }

  expect_failures = [var.apps_cloudflare_api_token]
}

run "platform_account_for_apps_fails" {
  command = plan

  variables {
    cloudflare_account_id      = "0123456789abcdef0123456789abcdef"
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "acme-apps.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
  }

  expect_failures = [var.apps_cloudflare_account_id]
}

run "us_jurisdiction_fails" {
  command = plan

  variables {
    app_data_jurisdiction = "us"
  }

  expect_failures = [var.app_data_jurisdiction]
}

run "web_domain_under_apps_domain_fails" {
  command = plan

  variables {
    cloudflare_custom_domain   = "inspect.acme-apps.example"
    cloudflare_zone_id         = "platform-zone"
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "acme-apps.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
  }

  expect_failures = [terraform_data.apps_domain_gate]
}

run "apps_domain_under_web_domain_is_allowed" {
  command = plan

  variables {
    cloudflare_custom_domain   = "acme.example"
    cloudflare_zone_id         = "platform-zone"
    apps_enabled               = true
    apps_cloudflare_account_id = "0123456789abcdef0123456789abcdef"
    apps_cloudflare_api_token  = "test-apps-terraform-token"
    apps_zone_id               = "fedcba9876543210fedcba9876543210"
    apps_domain                = "apps.acme.example"
    apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
    apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
  }

  assert {
    condition     = length(terraform_data.apps_domain_gate) == 1
    error_message = "A delegated apps subdomain under the web domain must plan."
  }
}
