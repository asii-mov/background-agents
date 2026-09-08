mock_provider "cloudflare" {}
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
  cloudflare_api_token             = "test-cloudflare-token"
  cloudflare_account_id            = "test-account"
  cloudflare_worker_subdomain      = "test-account"
  github_app_id                    = "1"
  github_app_private_key           = "test-private-key"
  github_app_installation_id       = "1"
  anthropic_api_key                = "test-anthropic-key"
  token_encryption_key             = "test-token-key"
  repo_secrets_encryption_key      = "test-repo-key"
  provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
  nextauth_secret                  = "test-browser-auth-secret-with-32-characters"
  deployment_name                  = "auth-provider-test"

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

run "github_only" {
  command = plan

  assert {
    condition     = local.github_oauth_enabled && !local.google_enabled
    error_message = "GitHub-only credentials must enable only GitHub."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "GITHUB_CLIENT_ID") &&
      !contains(module.control_plane_worker.plain_text_binding_names, "GOOGLE_CLIENT_ID") &&
      contains(module.control_plane_worker.secret_binding_names, "GITHUB_CLIENT_SECRET") &&
      !contains(module.control_plane_worker.secret_binding_names, "GOOGLE_CLIENT_SECRET")
    )
    error_message = "The control plane must bind only the enabled GitHub OAuth credential pair."
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "PROVIDER_ACCOUNTS_ENCRYPTION_KEY")
    error_message = "The control plane must bind the provider account credential encryption key."
  }

  assert {
    condition     = nonsensitive(local.effective_provider_accounts_encryption_key) == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    error_message = "An operator-provided provider account key must remain unchanged."
  }
}

run "cloudflare_access_environment" {
  command = plan

  assert {
    condition = (
      strcontains(local_file.web_app_wrangler_production[0].content, "CF_ACCESS_TEAM_DOMAIN = \"https://test-team.cloudflareaccess.com\"") &&
      strcontains(local_file.web_app_wrangler_production[0].content, "CF_ACCESS_AUD = \"test-openinspect-audience\"") &&
      !strcontains(local_file.web_app_wrangler_production[0].content, "AUTH_DEV_BYPASS")
    )
    error_message = "The web Worker must receive its Access issuer and audience without a development bypass."
  }
}

run "reject_missing_access_team" {
  command = plan
  variables {
    cf_access_team_domain = ""
  }
  expect_failures = [var.cf_access_team_domain]
}

run "reject_http_access_team" {
  command = plan
  variables {
    cf_access_team_domain = "http://test-team.cloudflareaccess.com"
  }
  expect_failures = [var.cf_access_team_domain]
}

run "reject_access_team_path" {
  command = plan
  variables {
    cf_access_team_domain = "https://test-team.cloudflareaccess.com/path"
  }
  expect_failures = [var.cf_access_team_domain]
}

run "reject_non_cloudflare_access_team" {
  command = plan
  variables {
    cf_access_team_domain = "https://untrusted.example.com"
  }
  expect_failures = [var.cf_access_team_domain]
}

run "reject_missing_access_audience" {
  command = plan
  variables {
    cf_access_aud = ""
  }
  expect_failures = [var.cf_access_aud]
}

run "reject_vercel_missing_access_audience" {
  command = plan
  variables {
    web_platform         = "vercel"
    vercel_api_token     = "test-vercel-token"
    vercel_team_id       = "test-vercel-team"
    vercel_custom_domain = "inspect.example.com"
    cf_access_aud        = ""
  }
  expect_failures = [var.cf_access_aud]
}

run "reject_vercel_without_custom_domain" {
  command = plan
  variables {
    web_platform         = "vercel"
    vercel_api_token     = "test-vercel-token"
    vercel_team_id       = "test-vercel-team"
    vercel_custom_domain = null
  }
  expect_failures = [terraform_data.vercel_custom_domain_gate]
}

run "terraform_generated_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = ""
  }

  override_resource {
    target          = random_bytes.provider_accounts_encryption_key
    override_during = plan
    values = {
      base64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    }
  }

  assert {
    condition = (
      nonsensitive(local.effective_provider_accounts_encryption_key) == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" &&
      length(base64decode(nonsensitive(local.effective_provider_accounts_encryption_key))) == 32
    )
    error_message = "Terraform must generate a Base64-encoded 32-byte provider account key."
  }
}

run "reject_malformed_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!="
  }

  expect_failures = [var.provider_accounts_encryption_key]
}

run "reject_31_byte_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZQ=="
  }

  expect_failures = [var.provider_accounts_encryption_key]
}

run "reject_33_byte_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYw"
  }

  expect_failures = [var.provider_accounts_encryption_key]
}

run "vercel_github_only" {
  command = plan

  variables {
    web_platform         = "vercel"
    vercel_api_token     = "test-vercel-token"
    vercel_team_id       = "test-vercel-team"
    vercel_custom_domain = "inspect.example.com"
  }

  assert {
    condition = (
      output.web_app_url == "https://inspect.example.com" &&
      module.web_app[0].custom_domain == "inspect.example.com" &&
      strcontains(
        nonsensitive(output.verification_commands),
        "curl https://inspect.example.com"
      )
    )
    error_message = "Vercel browser authentication and verification must use the Access-protected custom domain."
  }
}

run "google_only" {
  command = plan

  variables {
    github_client_id     = ""
    github_client_secret = ""
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
    allowed_users        = ""
    allowed_emails       = "person@example.com"
  }

  assert {
    condition     = !local.github_oauth_enabled && local.google_enabled
    error_message = "Google-only credentials must enable only Google."
  }

  assert {
    condition = (
      !contains(module.control_plane_worker.plain_text_binding_names, "GITHUB_CLIENT_ID") &&
      contains(module.control_plane_worker.plain_text_binding_names, "GOOGLE_CLIENT_ID") &&
      !contains(module.control_plane_worker.secret_binding_names, "GITHUB_CLIENT_SECRET") &&
      contains(module.control_plane_worker.secret_binding_names, "GOOGLE_CLIENT_SECRET")
    )
    error_message = "The control plane must bind only the enabled Google OAuth credential pair."
  }
}

run "github_and_google" {
  command = plan

  variables {
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
    allowed_emails       = "person@example.com"
  }

  assert {
    condition     = local.github_oauth_enabled && local.google_enabled
    error_message = "Complete GitHub and Google credentials must enable both providers."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "GITHUB_CLIENT_ID") &&
      contains(module.control_plane_worker.plain_text_binding_names, "GOOGLE_CLIENT_ID") &&
      contains(module.control_plane_worker.secret_binding_names, "GITHUB_CLIENT_SECRET") &&
      contains(module.control_plane_worker.secret_binding_names, "GOOGLE_CLIENT_SECRET")
    )
    error_message = "The control plane must bind both enabled OAuth credential pairs."
  }
}

run "no_provider" {
  command = plan

  variables {
    github_client_id     = ""
    github_client_secret = ""
  }

  expect_failures = [terraform_data.sign_in_provider_gate]
}

run "partial_github_pair" {
  command = plan

  variables {
    github_client_id     = "  "
    github_client_secret = "github-secret"
  }

  expect_failures = [var.github_client_id]
}

run "partial_google_pair" {
  command = plan

  variables {
    google_client_id     = "google-id"
    google_client_secret = "  "
  }

  expect_failures = [var.google_client_id]
}

run "google_with_github_only_admission" {
  command = plan

  variables {
    github_client_id     = ""
    github_client_secret = ""
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
  }

  expect_failures = [terraform_data.sign_in_provider_gate]
}

run "combined_with_github_only_admission" {
  command = plan

  variables {
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
  }

  expect_failures = [terraform_data.sign_in_provider_gate]
}

run "anthropic_api_key_blank" {
  command = plan

  variables {
    enable_slack_bot     = true
    slack_bot_token      = "test-slack-token"
    slack_signing_secret = "test-slack-signing-secret"
    anthropic_api_key    = ""
  }

  expect_failures = [var.anthropic_api_key]
}
