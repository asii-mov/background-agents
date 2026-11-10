# =============================================================================
# Internal app hosting: what the platform control plane learns
# =============================================================================
#
# The control plane reaches the broker in the apps account over HTTPS: sig1
# signed with the shared secret below, behind the broker's Access application
# with the service token from apps-account.tf. It never holds an apps-account
# API token.

resource "random_password" "service_auth_secret_app_broker" {
  count   = var.apps_enabled ? 1 : 0
  length  = 64
  special = false
}

locals {
  apps_control_plane_plain_text_bindings = merge(
    { SANDBOX_TUNNELS_POLICY = { value = var.sandbox_tunnels_policy } },
    var.apps_enabled ? {
      APP_BROKER_URL              = { value = "https://${local.apps_broker_host}" }
      APPS_DOMAIN                 = { value = var.apps_domain }
      APP_BROKER_ACCESS_CLIENT_ID = { value = cloudflare_zero_trust_access_service_token.control_plane[0].client_id }
      APP_DATA_JURISDICTION       = { value = var.app_data_jurisdiction }
    } : {}
  )

  apps_control_plane_secrets = var.apps_enabled ? {
    SERVICE_AUTH_SECRET_APP_BROKER  = { value = random_password.service_auth_secret_app_broker[0].result }
    APP_BROKER_ACCESS_CLIENT_SECRET = { value = cloudflare_zero_trust_access_service_token.control_plane[0].client_secret }
  } : {}
}
