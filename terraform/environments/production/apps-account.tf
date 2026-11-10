# =============================================================================
# Internal app hosting: the dedicated apps account (docs/APPS.md)
# =============================================================================
#
# Everything here lives in the apps account through the cloudflare.apps
# provider. Security decides it in Terraform: who may visit an app (the visitor
# policy), the *.<apps_domain> Access floor that gates every hostname from the
# moment DNS exists, and the broker Worker that alone holds the apps-account
# token. The control plane learns only the broker URL and two credentials
# (apps.tf).

resource "cloudflare_zero_trust_access_policy" "app_visitors" {
  provider   = cloudflare.apps
  count      = var.apps_enabled ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "Open-Inspect app visitors (${local.name_suffix})"
  decision   = "allow"
  include    = var.apps_access_include
  require    = length(var.apps_access_require) > 0 ? var.apps_access_require : null
}

# The broker attaches this same policy to each app's exact-hostname Access app,
# which takes precedence over the floor and gives every app its own AUD.
resource "cloudflare_zero_trust_access_application" "apps_floor" {
  provider                   = cloudflare.apps
  count                      = var.apps_enabled ? 1 : 0
  account_id                 = var.apps_cloudflare_account_id
  name                       = "Open-Inspect apps floor (${local.name_suffix})"
  type                       = "self_hosted"
  domain                     = "*.${var.apps_domain}"
  destinations               = [{ type = "public", uri = "*.${var.apps_domain}" }]
  policies                   = [{ id = cloudflare_zero_trust_access_policy.app_visitors[0].id, precedence = 1 }]
  app_launcher_visible       = false
  http_only_cookie_attribute = true
}

# ---- The broker's own hostname: the control plane's service token only ------

resource "cloudflare_zero_trust_access_service_token" "control_plane" {
  provider   = cloudflare.apps
  count      = var.apps_enabled ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "open-inspect-control-plane-${local.name_suffix}"

  # Replacing it (rotation, or before it expires) admits the new token first.
  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "broker_service" {
  provider   = cloudflare.apps
  count      = var.apps_enabled ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "Open-Inspect app broker: control plane (${local.name_suffix})"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.control_plane[0].id } }]
}

resource "cloudflare_zero_trust_access_application" "broker" {
  provider                  = cloudflare.apps
  count                     = var.apps_enabled ? 1 : 0
  account_id                = var.apps_cloudflare_account_id
  name                      = "Open-Inspect app broker (${local.name_suffix})"
  type                      = "self_hosted"
  domain                    = local.apps_broker_host
  destinations              = [{ type = "public", uri = local.apps_broker_host }]
  policies                  = [{ id = cloudflare_zero_trust_access_policy.broker_service[0].id, precedence = 1 }]
  app_launcher_visible      = false
  service_auth_401_redirect = true
}

# ---- The broker's runtime token, minted in the apps account ------------------

data "cloudflare_account_api_token_permission_groups_list" "apps" {
  provider   = cloudflare.apps
  count      = var.apps_enabled ? 1 : 0
  account_id = var.apps_cloudflare_account_id
}

module "apps_broker_permissions" {
  count     = var.apps_enabled ? 1 : 0
  source    = "../../modules/cloudflare-token-permissions"
  available = data.cloudflare_account_api_token_permission_groups_list.apps[0].result

  # Workers Scripts Write also covers scripts in a dispatch namespace.
  required = {
    "com.cloudflare.api.account" = [
      "Workers Scripts Write",
      "Access: Apps and Policies Write",
      "D1 Write",
      "Workers KV Storage Write",
      "Workers R2 Storage Write",
    ]
    "com.cloudflare.api.account.zone" = ["Workers Routes Write", "DNS Write"]
  }
}

resource "cloudflare_account_token" "app_broker" {
  provider   = cloudflare.apps
  count      = var.apps_enabled ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "open-inspect-app-broker-${local.name_suffix}"
  policies = [
    for scope, resource_key in {
      "com.cloudflare.api.account"      = "com.cloudflare.api.account.${var.apps_cloudflare_account_id}"
      "com.cloudflare.api.account.zone" = "com.cloudflare.api.account.zone.${var.apps_zone_id}"
      } : {
      effect            = "allow"
      permission_groups = [for id in module.apps_broker_permissions[0].ids[scope] : { id = id }]
      resources         = jsonencode({ (resource_key) = "*" })
    }
  ]

  # Replacing it (rotation) deploys the broker with the new token before the
  # old one is revoked.
  lifecycle {
    create_before_destroy = true
  }
}

# ---- Workers for Platforms (apps_hosting_backend = "dispatch-namespace") -----

resource "cloudflare_workers_for_platforms_dispatch_namespace" "apps" {
  provider   = cloudflare.apps
  count      = local.apps_wfp ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "open-inspect-apps-${local.name_suffix}"
}

# Build the broker and dispatcher bundles (only runs during apply, not plan)
resource "null_resource" "app_broker_build" {
  count = var.apps_enabled ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/app-broker"
  }
}

# Reached only through the per-app custom domains the broker attaches after
# their Access apps exist.
module "apps_dispatcher" {
  count     = local.apps_wfp ? 1 : 0
  source    = "../../modules/cloudflare-worker"
  providers = { cloudflare = cloudflare.apps }

  account_id          = var.apps_cloudflare_account_id
  worker_name         = "open-inspect-app-dispatcher-${local.name_suffix}"
  workers_dev_enabled = false
  script_path         = local.app_dispatcher_script_path
  compatibility_date  = local.apps_compatibility_date

  dispatch_namespaces = {
    DISPATCHER = { namespace = cloudflare_workers_for_platforms_dispatch_namespace.apps[0].name }
  }

  plain_text_bindings = {
    APPS_DOMAIN        = { value = var.apps_domain }
    APPS_SCRIPT_PREFIX = { value = local.apps_script_prefix }
  }

  depends_on = [null_resource.app_broker_build]
}

# ---- The broker Worker -------------------------------------------------------

module "app_broker" {
  count     = var.apps_enabled ? 1 : 0
  source    = "../../modules/cloudflare-worker"
  providers = { cloudflare = cloudflare.apps }

  account_id          = var.apps_cloudflare_account_id
  zone_id             = var.apps_zone_id
  worker_name         = "open-inspect-app-broker-${local.name_suffix}"
  workers_dev_enabled = false
  custom_domain       = local.apps_broker_host
  script_path         = local.app_broker_script_path
  compatibility_date  = local.apps_compatibility_date

  plain_text_bindings = merge(
    {
      APPS_ACCOUNT_ID          = { value = var.apps_cloudflare_account_id }
      APPS_ZONE_ID             = { value = var.apps_zone_id }
      APPS_DOMAIN              = { value = var.apps_domain }
      APPS_SCRIPT_PREFIX       = { value = local.apps_script_prefix }
      APPS_HOSTING_BACKEND     = { value = var.apps_hosting_backend }
      APPS_ACCESS_TEAM_DOMAIN  = { value = var.apps_access_team_domain }
      APPS_ACCESS_POLICY_ID    = { value = cloudflare_zero_trust_access_policy.app_visitors[0].id }
      APPS_ACCESS_FLOOR_APP_ID = { value = cloudflare_zero_trust_access_application.apps_floor[0].id }
      APP_DATA_JURISDICTION    = { value = var.app_data_jurisdiction }
    },
    local.apps_wfp ? {
      APPS_DISPATCH_NAMESPACE = { value = cloudflare_workers_for_platforms_dispatch_namespace.apps[0].name }
      APPS_DISPATCHER_SERVICE = { value = module.apps_dispatcher[0].worker_name }
    } : {}
  )

  secrets = {
    APPS_API_TOKEN                    = { value = cloudflare_account_token.app_broker[0].value }
    SERVICE_AUTH_SECRET_CONTROL_PLANE = { value = random_password.service_auth_secret_app_broker[0].result }
  }

  # The broker's hostname is gated by its own Access app and the floor before
  # the custom domain makes it resolve.
  depends_on = [
    null_resource.app_broker_build,
    cloudflare_zero_trust_access_application.broker,
    cloudflare_zero_trust_access_application.apps_floor,
  ]
}
