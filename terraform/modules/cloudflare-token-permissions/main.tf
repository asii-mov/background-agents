# Resolves the permission group names an API token needs into the group ids
# Cloudflare expects. Pure: the caller reads the account's groups (the
# cloudflare_account_api_token_permission_groups_list data source) and passes
# them in, so a misspelt or retired name fails the plan instead of minting a
# token without that permission.

variable "available" {
  description = "Permission groups the account offers, as cloudflare_account_api_token_permission_groups_list returns them."
  type = list(object({
    id     = string
    name   = string
    scopes = list(string)
  }))
}

variable "required" {
  description = "Permission group names the token needs, keyed by the scope they apply to, e.g. com.cloudflare.api.account."
  type        = map(list(string))
}

locals {
  matches = {
    for scope, names in var.required : scope => {
      for name in names : name => [for group in var.available : group.id if group.name == name && contains(group.scopes, scope)]
    }
  }
}

output "ids" {
  description = "Permission group ids keyed by scope."
  value       = { for scope, names in local.matches : scope => [for name, ids in names : one(ids)] }

  precondition {
    condition     = alltrue(flatten([for names in local.matches : [for ids in values(names) : length(ids) == 1]]))
    error_message = "Each required permission group must match exactly one group in its scope. Unmatched: ${jsonencode({ for scope, names in local.matches : scope => [for name, ids in names : name if length(ids) != 1] })}."
  }
}
