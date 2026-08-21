variable "create_cdn" {
  description = "Front the ALB with CloudFront so the API + console get trusted HTTPS out of the box (the *.cloudfront.net domain ships with a valid certificate)"
  type        = bool
  default     = true
}

variable "cdn_aliases" {
  description = "Custom domains for the CDN (e.g. [\"agents.yourco.com\"]) — requires cdn_certificate_arn"
  type        = list(string)
  default     = []
}

variable "cdn_certificate_arn" {
  description = "ACM certificate for cdn_aliases. Must live in us-east-1 (CloudFront requirement)."
  type        = string
  default     = ""
}

# Pure pass-through: caching disabled, every header/cookie/query forwarded
# (except Host — the ALB doesn't route on it), all methods allowed. The CDN
# exists for its certificate, not for caching.
resource "aws_cloudfront_distribution" "api" {
  count   = var.create_alb && var.create_cdn ? 1 : 0
  enabled = true
  comment = "${var.project} — HTTPS front for the API + console"

  aliases     = var.cdn_aliases
  price_class = "PriceClass_100"

  origin {
    origin_id   = "${var.project}-alb"
    domain_name = aws_lb.api[0].dns_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "${var.project}-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    # AWS managed policies: CachingDisabled + AllViewerExceptHostHeader
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.cdn_certificate_arn == ""
    acm_certificate_arn            = var.cdn_certificate_arn == "" ? null : var.cdn_certificate_arn
    ssl_support_method             = var.cdn_certificate_arn == "" ? null : "sni-only"
    minimum_protocol_version       = var.cdn_certificate_arn == "" ? "TLSv1" : "TLSv1.2_2021"
  }
}

output "cdn_domain" {
  value = var.create_alb && var.create_cdn ? aws_cloudfront_distribution.api[0].domain_name : "(no CDN — create_cdn = false)"
}
