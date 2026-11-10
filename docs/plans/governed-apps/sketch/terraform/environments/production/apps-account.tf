# terraform/environments/production/apps-account.tf  (FINAL sketch)
#
# Two accounts, two providers:
#   cloudflare       the platform account (control plane and everything that exists today)
#   cloudflare.apps  the company-owned APPS account: broker Worker, app Workers, app data, its own
#                    Zero Trust org (IdP shared via IdP federation or re-registered)
# Terraform owns everything security decides. The control plane learns a URL and two secrets.

# ---- variables.tf additions ----------------------------------------------------------------------
variable "apps_enabled" { type = bool  default = false }
variable "apps_cloudflare_account_id" { type = string  default = "" }
variable "apps_terraform_api_token" {           # operator token for provider alias; never reaches a Worker
  type = string  sensitive = true  default = ""
}
variable "apps_zone_id" { type = string  default = "" }
variable "apps_domain" {                        # e.g. apps.acme-apps.example; each app is <name>.<this>
  type = string  default = ""
  validation { condition = var.apps_domain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.apps_domain)); error_message = "bare lowercase hostname" }
}
variable "apps_hosting_backend" {
  type = string  default = "workers"
  validation { condition = contains(["workers", "dispatch-namespace"], var.apps_hosting_backend); error_message = "workers or dispatch-namespace" }
}
variable "apps_access_team_domain" { type = string  default = "" }   # https://<team>.cloudflareaccess.com of the apps org
variable "apps_access_include" { type = any  default = [] }           # provider v5 include rules; security-owned
variable "apps_access_require" { type = any  default = [] }           # e.g. device posture (needs WARP enrolment in the apps org)
variable "apps_broker_api_token_override" {    # fallback when cloudflare_account_token is unavailable
  type = string  sensitive = true  default = ""
}
variable "app_data_jurisdiction" {
  type = string  default = ""
  validation { condition = contains(["", "eu", "us", "fedramp"], var.app_data_jurisdiction); error_message = "\"\", eu, us or fedramp" }
}
variable "sandbox_tunnels_policy" {
  type = string  default = "public"
  validation { condition = contains(["public", "disabled"], var.sandbox_tunnels_policy); error_message = "public or disabled" }
}

locals {
  apps_on            = var.apps_enabled
  apps_wfp           = var.apps_enabled && var.apps_hosting_backend == "dispatch-namespace"
  apps_script_prefix = "app-"                                   # one grammar for scripts and data resources
  apps_broker_host   = "deployer.${var.apps_domain}"           # APP_BROKER_HOST_LABEL; in RESERVED_APP_NAMES
}

# ---- versions.tf: provider alias -----------------------------------------------------------------
# provider "cloudflare" { alias = "apps"  api_token = var.apps_terraform_api_token }

# ---- Access: visitor policy, wildcard floor, broker service token ---------------------------------
resource "cloudflare_zero_trust_access_policy" "app_visitors" {
  provider   = cloudflare.apps
  count      = local.apps_on ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "Open-Inspect app visitors (${local.name_suffix})"
  decision   = "allow"
  include    = var.apps_access_include
  require    = var.apps_access_require
  lifecycle {
    precondition {
      condition     = length(var.apps_access_include) > 0 && var.apps_domain != "" && var.apps_zone_id != "" && var.apps_access_team_domain != ""
      error_message = "apps_enabled requires apps_domain, apps_zone_id, apps_access_team_domain and a non-empty apps_access_include."
    }
  }
}

# Every one-label hostname under the apps domain is gated from the moment DNS exists, whatever the
# broker does. Per-app exact-hostname apps (created by the broker, same policy) take precedence and
# give each app its own AUD. (smoke: exact beats wildcard for public self-hosted apps)
resource "cloudflare_zero_trust_access_application" "apps_floor" {
  provider                   = cloudflare.apps
  count                      = local.apps_on ? 1 : 0
  account_id                 = var.apps_cloudflare_account_id
  name                       = "Open-Inspect apps floor (${local.name_suffix})"
  type                       = "self_hosted"
  domain                     = "*.${var.apps_domain}"
  destinations               = [{ type = "public", uri = "*.${var.apps_domain}" }]
  policies                   = [{ id = cloudflare_zero_trust_access_policy.app_visitors[0].id, precedence = 1 }]
  app_launcher_visible       = false
  http_only_cookie_attribute = true
}

resource "cloudflare_zero_trust_access_service_token" "control_plane" {
  provider   = cloudflare.apps
  count      = local.apps_on ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "open-inspect-control-plane-${local.name_suffix}"
  duration   = "8760h"
}
resource "cloudflare_zero_trust_access_policy" "broker_service" {
  provider   = cloudflare.apps
  count      = local.apps_on ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "Open-Inspect broker: control plane service token (${local.name_suffix})"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.control_plane[0].id } }]
}
# Exact hostname: takes precedence over the floor, so the control plane is never redirected to SSO.
resource "cloudflare_zero_trust_access_application" "broker" {
  provider             = cloudflare.apps
  count                = local.apps_on ? 1 : 0
  account_id           = var.apps_cloudflare_account_id
  name                 = "Open-Inspect app deployer (${local.name_suffix})"
  type                 = "self_hosted"
  domain               = local.apps_broker_host
  destinations         = [{ type = "public", uri = local.apps_broker_host }]
  policies             = [{ id = cloudflare_zero_trust_access_policy.broker_service[0].id, precedence = 1 }]
  app_launcher_visible = false
}

# ---- Broker runtime token (minted, not pasted; rotate by taint + apply) ---------------------------
data "cloudflare_account_api_token_permission_groups_list" "apps" {
  provider   = cloudflare.apps
  count      = local.apps_on && var.apps_broker_api_token_override == "" ? 1 : 0
  account_id = var.apps_cloudflare_account_id
}
locals {
  # Names resolved against the data source: Workers Scripts Write, Workers Custom Domains? (via Workers
  # Routes/Zone), Access: Apps and Policies Write, D1 Write, Workers KV Storage Write, Workers R2 Storage
  # Write, (+ Workers for Platforms Write when apps_wfp). Verified in Unit 7 against the pinned provider.
  apps_broker_permission_group_names = concat(
    ["Workers Scripts Write", "Access: Apps and Policies Write", "D1 Write", "Workers KV Storage Write", "Workers R2 Storage Write"],
    local.apps_wfp ? ["Workers for Platforms Write"] : []
  )
}
resource "cloudflare_account_token" "app_broker" {
  provider   = cloudflare.apps
  count      = local.apps_on && var.apps_broker_api_token_override == "" ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "open-inspect-app-broker-${local.name_suffix}"
  policies = [
    { effect = "allow", permission_groups = [for g in data.cloudflare_account_api_token_permission_groups_list.apps[0].result : { id = g.id } if contains(local.apps_broker_permission_group_names, g.name)],
      resources = { "com.cloudflare.api.account.${var.apps_cloudflare_account_id}" = "*" } },
    { effect = "allow", permission_groups = [for g in data.cloudflare_account_api_token_permission_groups_list.apps[0].result : { id = g.id } if g.name == "Workers Routes Write" || g.name == "DNS Write"],
      resources = { "com.cloudflare.api.account.zone.${var.apps_zone_id}" = "*" } },
  ]
}
locals { apps_broker_api_token = local.apps_on ? (var.apps_broker_api_token_override != "" ? var.apps_broker_api_token_override : cloudflare_account_token.app_broker[0].value) : "" }

# ---- sig1 shared secret (platform <-> broker) ------------------------------------------------------
resource "random_password" "service_auth_secret_app_broker" { length = 64  special = false }

# ---- Workers for Platforms (optional) -------------------------------------------------------------
resource "cloudflare_workers_for_platforms_dispatch_namespace" "apps" {
  provider   = cloudflare.apps
  count      = local.apps_wfp ? 1 : 0
  account_id = var.apps_cloudflare_account_id
  name       = "open-inspect-apps-${local.name_suffix}"
}
module "apps_dispatcher" {
  count     = local.apps_wfp ? 1 : 0
  source    = "../../modules/cloudflare-worker"
  providers = { cloudflare = cloudflare.apps }
  account_id          = var.apps_cloudflare_account_id
  worker_name         = "open-inspect-app-dispatcher-${local.name_suffix}"
  worker_subdomain    = var.cloudflare_worker_subdomain
  workers_dev_enabled = false                           # NEW module input: subdomain { enabled, previews_enabled }
  script_path         = "${var.project_root}/packages/app-broker/dist/dispatcher.js"
  dispatch_namespaces = { DISPATCHER = { namespace = cloudflare_workers_for_platforms_dispatch_namespace.apps[0].name } }  # NEW module input
  plain_text_bindings = { APPS_DOMAIN = { value = var.apps_domain }, APPS_SCRIPT_PREFIX = { value = local.apps_script_prefix } }
}

# ---- The broker Worker -----------------------------------------------------------------------------
module "app_broker" {
  count     = local.apps_on ? 1 : 0
  source    = "../../modules/cloudflare-worker"
  providers = { cloudflare = cloudflare.apps }
  account_id          = var.apps_cloudflare_account_id
  zone_id             = var.apps_zone_id
  worker_name         = "open-inspect-app-broker-${local.name_suffix}"
  worker_subdomain    = var.cloudflare_worker_subdomain
  workers_dev_enabled = false
  custom_domain       = local.apps_broker_host
  script_path         = "${var.project_root}/packages/app-broker/dist/index.js"
  plain_text_bindings = merge({
    APPS_ACCOUNT_ID          = { value = var.apps_cloudflare_account_id }
    APPS_ZONE_ID             = { value = var.apps_zone_id }
    APPS_DOMAIN              = { value = var.apps_domain }
    APPS_SCRIPT_PREFIX       = { value = local.apps_script_prefix }
    APPS_HOSTING_BACKEND     = { value = var.apps_hosting_backend }
    APPS_ACCESS_TEAM_DOMAIN  = { value = var.apps_access_team_domain }
    APPS_ACCESS_POLICY_ID    = { value = cloudflare_zero_trust_access_policy.app_visitors[0].id }
    APPS_ACCESS_FLOOR_APP_ID = { value = cloudflare_zero_trust_access_application.apps_floor[0].id }
    APP_DATA_JURISDICTION    = { value = var.app_data_jurisdiction }
  }, local.apps_wfp ? {
    APPS_DISPATCH_NAMESPACE = { value = cloudflare_workers_for_platforms_dispatch_namespace.apps[0].name }
    APPS_DISPATCHER_SERVICE = { value = module.apps_dispatcher[0].worker_name }
  } : {})
  secrets = {
    APPS_API_TOKEN                    = { value = local.apps_broker_api_token }
    SERVICE_AUTH_SECRET_CONTROL_PLANE = { value = random_password.service_auth_secret_app_broker.result }
  }
  depends_on = [cloudflare_zero_trust_access_application.broker]   # Access before the hostname exists
}

# ---- apps.tf: what the PLATFORM account's control plane learns (merged into module.control_plane_worker)
# plain_text_bindings += local.apps_on ? {
#   APP_BROKER_URL          = { value = "https://${local.apps_broker_host}" }
#   APPS_DOMAIN             = { value = var.apps_domain }
#   APP_DATA_JURISDICTION   = { value = var.app_data_jurisdiction }
#   SANDBOX_TUNNELS_POLICY  = { value = var.sandbox_tunnels_policy }
# } : { SANDBOX_TUNNELS_POLICY = { value = var.sandbox_tunnels_policy } }
# secrets += local.apps_on ? {
#   SERVICE_AUTH_SECRET_APP_BROKER  = { value = random_password.service_auth_secret_app_broker.result }
#   APP_BROKER_ACCESS_CLIENT_ID     = { value = cloudflare_zero_trust_access_service_token.control_plane[0].client_id }
#   APP_BROKER_ACCESS_CLIENT_SECRET = { value = cloudflare_zero_trust_access_service_token.control_plane[0].client_secret }
# } : {}
#
# checks.tf: the web app's custom domain must not live under apps_domain (the floor would cover it).
# D1 migrations 0104-0106 are applied by the existing null_resource.d1_migrations (platform account).
