"""JARVIS Swarm Agent - Security Auditor

Specialized agent for security vulnerability scanning, threat analysis,
and security auditing. Covers OWASP Top 10 and common vulnerability patterns.
"""
import logging
import re
import time
from typing import Any, Dict, List, Optional

from .base_agent import BaseAgent, AgentStatus

logger = logging.getLogger("jarvis.swarm.security_auditor")


class SecurityAuditorAgent(BaseAgent):
    """Agent specialized in security auditing and vulnerability detection.

    Capabilities:
    - OWASP Top 10 vulnerability scanning
    - SQL injection detection
    - XSS detection
    - CSRF vulnerability detection
    - Authentication/authorization flaws
    - Sensitive data exposure detection
    - Security misconfiguration detection
    - Dependency vulnerability assessment
    - Threat modeling and analysis

    Attributes:
        severity_levels: Available severity levels for findings.
        scan_profiles: Predefined scan profiles for different contexts.
    """

    # OWASP Top 10 vulnerability patterns
    VULNERABILITY_PATTERNS = {
        # A01: Broken Access Control
        "broken_access_control": [
            {"pattern": r"@app\.route\s*\(\s*['\"].*['\"]\s*,\s*methods\s*=\s*\[.*\]\s*\)\s*$",
             "name": "Unprotected route", "severity": "high",
             "message": "Route lacks authentication middleware",
             "owasp": "A01:2021-Broken Access Control"},
            {"pattern": r"is_admin\s*=\s*True|admin\s*=\s*True|role\s*=\s*['\"]admin['\"]",
             "name": "Hardcoded admin flag", "severity": "critical",
             "message": "Admin privilege hardcoded in source code",
             "owasp": "A01:2021-Broken Access Control"},
        ],
        # A02: Cryptographic Failures
        "crypto_failures": [
            {"pattern": r"hashlib\.(md5|sha1)\s*\(", "name": "Weak hash algorithm", "severity": "high",
             "message": "MD5/SHA1 are cryptographically broken - use SHA256+",
             "owasp": "A02:2021-Cryptographic Failures"},
            {"pattern": r"DES|RC4|Blowfish", "name": "Weak cipher", "severity": "critical",
             "message": "Weak cryptographic algorithm detected",
             "owasp": "A02:2021-Cryptographic Failures"},
            {"pattern": r"random\.(random|randint|choice)", "name": "Insecure random", "severity": "high",
             "message": "Use secrets module for cryptographic random generation",
             "owasp": "A02:2021-Cryptographic Failures"},
            {"pattern": r"http://", "name": "Unencrypted HTTP", "severity": "warning",
             "message": "HTTP connection detected - use HTTPS for sensitive data",
             "owasp": "A02:2021-Cryptographic Failures"},
        ],
        # A03: Injection
        "injection": [
            {"pattern": r"execute\s*\(\s*[\"'].*%s.*[\"']\s*%", "name": "SQL injection risk", "severity": "critical",
             "message": "String formatting in SQL query - use parameterized queries",
             "owasp": "A03:2021-Injection"},
            {"pattern": r"cursor\.execute\s*\(\s*[\"'].*\+\s*\w+", "name": "SQL concatenation", "severity": "critical",
             "message": "SQL query built with string concatenation - vulnerable to injection",
             "owasp": "A03:2021-Injection"},
            {"pattern": r"f[\"'].*SELECT.*{.*}.*[\"']|f[\"'].*INSERT.*{.*}.*[\"']|f[\"'].*UPDATE.*{.*}.*[\"']|f[\"'].*DELETE.*{.*}.*[\"']",
             "name": "f-string SQL", "severity": "critical",
             "message": "f-string used in SQL query - vulnerable to injection",
             "owasp": "A03:2021-Injection"},
            {"pattern": r"subprocess\.(call|run|Popen)\s*\([^)]*shell\s*=\s*True",
             "name": "Shell injection risk", "severity": "critical",
             "message": "subprocess with shell=True is vulnerable to command injection",
             "owasp": "A03:2021-Injection"},
            {"pattern": r"os\.system\s*\(", "name": "OS command execution", "severity": "critical",
             "message": "os.system() is vulnerable to command injection",
             "owasp": "A03:2021-Injection"},
            {"pattern": r"\$\{.*\}.*(?:echo|cat|ls|rm|wget|curl)", "name": "Template injection", "severity": "critical",
             "message": "Potential server-side template injection detected",
             "owasp": "A03:2021-Injection"},
        ],
        # A04: Insecure Design
        "insecure_design": [
            {"pattern": r"password\s*=\s*request\.(args|form|json)", "name": "Password in request", "severity": "high",
             "message": "Password received via non-secure channel or without validation",
             "owasp": "A04:2021-Insecure Design"},
            {"pattern": r"rate_limit\s*=\s*(0|False|None)", "name": "No rate limiting", "severity": "high",
             "message": "Rate limiting disabled - vulnerable to brute force",
             "owasp": "A04:2021-Insecure Design"},
        ],
        # A05: Security Misconfiguration
        "security_misconfig": [
            {"pattern": r"DEBUG\s*=\s*True", "name": "Debug mode enabled", "severity": "high",
             "message": "Debug mode should be disabled in production",
             "owasp": "A05:2021-Security Misconfiguration"},
            {"pattern": r"CORS.*\*|cors_origins.*\*", "name": "Permissive CORS", "severity": "warning",
             "message": "CORS allows all origins - restrict to specific domains",
             "owasp": "A05:2021-Security Misconfiguration"},
            {"pattern": r"SECRET_KEY\s*=\s*['\"][^'\"]{1,20}['\"]", "name": "Weak secret key", "severity": "high",
             "message": "Secret key appears to be weak or hardcoded",
             "owasp": "A05:2021-Security Misconfiguration"},
            {"pattern": r"ssl_verify\s*=\s*False|verify\s*=\s*False", "name": "SSL verification disabled", "severity": "critical",
             "message": "SSL certificate verification is disabled",
             "owasp": "A05:2021-Security Misconfiguration"},
        ],
        # A07: Identification and Authentication Failures
        "auth_failures": [
            {"pattern": r"password\s*==\s*['\"]", "name": "Plaintext password comparison", "severity": "critical",
             "message": "Password compared in plaintext - use constant-time comparison with hash",
             "owasp": "A07:2021-Identification and Authentication Failures"},
            {"pattern": r"session\s*=\s*request\.(args|params)", "name": "Session in URL", "severity": "critical",
             "message": "Session token in URL parameter - vulnerable to leakage",
             "owasp": "A07:2021-Identification and Authentication Failures"},
            {"pattern": r"jwt\.decode\s*\([^)]*(?!algorithms)", "name": "JWT algorithm confusion", "severity": "high",
             "message": "JWT decode without explicit algorithm specification",
             "owasp": "A07:2021-Identification and Authentication Failures"},
        ],
        # A08: Software and Data Integrity Failures
        "integrity_failures": [
            {"pattern": r"pip install.*--no-verify|npm install.*--ignore-scripts",
             "name": "Integrity check bypass", "severity": "warning",
             "message": "Package integrity verification is being bypassed",
             "owasp": "A08:2021-Software and Data Integrity Failures"},
        ],
        # A09: Security Logging and Monitoring Failures
        "logging_failures": [
            {"pattern": r"try:\s*\n\s*.*\s*\n\s*except\s*:\s*\n\s*pass",
             "name": "Silent exception", "severity": "warning",
             "message": "Exception silently caught and ignored - may hide security events",
             "owasp": "A09:2021-Security Logging and Monitoring Failures"},
        ],
        # Sensitive Data Exposure
        "data_exposure": [
            {"pattern": r"(password|passwd|pwd|secret|token|api_key|apikey|access_key)\s*[:=]\s*['\"][^'\"]+['\"]",
             "name": "Hardcoded credential", "severity": "critical",
             "message": "Hardcoded credential detected in source code",
             "owasp": "A02:2021-Cryptographic Failures"},
            {"pattern": r"\b\d{3}[-.]?\d{2}[-.]?\d{4}\b", "name": "SSN pattern", "severity": "critical",
             "message": "Potential Social Security Number detected",
             "owasp": "A02:2021-Cryptographic Failures"},
            {"pattern": r"\b\d{16}\b", "name": "Credit card number", "severity": "critical",
             "message": "Potential credit card number detected",
             "owasp": "A02:2021-Cryptographic Failures"},
            {"pattern": r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
             "name": "Email address", "severity": "info",
             "message": "Email address found in source code",
             "owasp": "A02:2021-Cryptographic Failures"},
        ],
        # XSS patterns
        "xss": [
            {"pattern": r"innerHTML\s*=|\.html\s*\(", "name": "DOM XSS risk", "severity": "high",
             "message": "Direct HTML assignment - potential XSS vulnerability",
             "owasp": "A03:2021-Injection"},
            {"pattern": r"document\.write\s*\(", "name": "document.write", "severity": "high",
             "message": "document.write() can lead to XSS",
             "owasp": "A03:2021-Injection"},
            {"pattern": r"\|safe\b", "name": "Unescaped output", "severity": "warning",
             "message": "Template output marked as safe - ensure content is sanitized",
             "owasp": "A03:2021-Injection"},
        ],
    }

    SEVERITY_LEVELS = ["info", "low", "warning", "medium", "high", "critical"]

    SCAN_PROFILES = {
        "quick": ["injection", "data_exposure", "crypto_failures"],
        "standard": ["injection", "data_exposure", "crypto_failures", "auth_failures", "security_misconfig", "xss"],
        "comprehensive": None,  # All categories
        "owasp_top10": None,  # All categories (same as comprehensive)
    }

    def __init__(
        self,
        agent_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(
            agent_id=agent_id,
            name="SecurityAuditor",
            description="Scans code and infrastructure for security vulnerabilities and provides threat analysis",
            config=config,
        )
        self._scan_history: List[Dict[str, Any]] = []
        self._false_positive_tracker: Dict[str, int] = {}

    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a security audit task.

        Args:
            task: Task dict with 'type' and relevant parameters.

        Returns:
            Audit result with findings and risk assessment.
        """
        task_type = task.get("type", "scan_vulnerabilities")

        if task_type == "scan_vulnerabilities":
            return await self.scan_vulnerabilities(
                code=task.get("code", ""),
                language=task.get("language", "python"),
                scan_profile=task.get("scan_profile", "standard"),
            )
        elif task_type == "audit_security":
            return await self.audit_security(
                target=task.get("target", {}),
                scope=task.get("scope", "full"),
            )
        elif task_type == "threat_analysis":
            return await self.threat_analysis(
                context=task.get("context", {}),
                assets=task.get("assets", []),
            )
        else:
            return {"success": False, "error": f"Unknown task type: {task_type}"}

    def get_capabilities(self) -> List[Dict[str, Any]]:
        """Return agent capabilities."""
        return [
            {
                "name": "scan_vulnerabilities",
                "description": "Scan code for security vulnerabilities using pattern matching",
                "parameters": {
                    "code": {"type": "string", "required": True, "description": "Source code to scan"},
                    "language": {"type": "string", "required": False, "default": "python"},
                    "scan_profile": {"type": "string", "required": False, "default": "standard",
                                     "enum": ["quick", "standard", "comprehensive", "owasp_top10"]},
                },
            },
            {
                "name": "audit_security",
                "description": "Perform a comprehensive security audit on a target system",
                "parameters": {
                    "target": {"type": "object", "required": True, "description": "Target configuration"},
                    "scope": {"type": "string", "required": False, "default": "full"},
                },
            },
            {
                "name": "threat_analysis",
                "description": "Analyze threats and produce a threat model",
                "parameters": {
                    "context": {"type": "object", "required": True, "description": "System context"},
                    "assets": {"type": "array", "required": False, "default": []},
                },
            },
        ]

    async def scan_vulnerabilities(
        self,
        code: str,
        language: str = "python",
        scan_profile: str = "standard",
    ) -> Dict[str, Any]:
        """Scan code for security vulnerabilities.

        Args:
            code: Source code to scan.
            language: Programming language.
            scan_profile: Scan profile to use (quick, standard, comprehensive, owasp_top10).

        Returns:
            Vulnerability scan results with findings and risk score.
        """
        start_time = time.time()
        self.logger.info("Security scan: %d chars, language=%s, profile=%s",
                        len(code), language, scan_profile)

        if not code.strip():
            return {"success": False, "error": "Empty code provided"}

        # Determine which categories to scan
        categories = self.SCAN_PROFILES.get(scan_profile)
        if categories is None:
            categories = list(self.VULNERABILITY_PATTERNS.keys())

        findings = []
        for category in categories:
            patterns = self.VULNERABILITY_PATTERNS.get(category, [])
            for pattern_def in patterns:
                try:
                    matches = list(re.finditer(pattern_def["pattern"], code, re.MULTILINE | re.IGNORECASE))
                    for match in matches:
                        line_num = code[:match.start()].count("\n") + 1
                        finding = {
                            "category": category,
                            "type": pattern_def["name"],
                            "severity": pattern_def["severity"],
                            "message": pattern_def["message"],
                            "owasp": pattern_def.get("owasp", ""),
                            "line": line_num,
                            "match": match.group()[:100],
                        }
                        findings.append(finding)
                except re.error:
                    self.logger.warning("Invalid regex: %s", pattern_def["pattern"])

        # Compute risk score
        risk_score = self._compute_risk_score(findings)

        # Group findings by severity
        severity_counts: Dict[str, int] = {}
        for f in findings:
            sev = f["severity"]
            severity_counts[sev] = severity_counts.get(sev, 0) + 1

        # Group findings by OWASP category
        owasp_counts: Dict[str, int] = {}
        for f in findings:
            owasp = f.get("owasp", "Unknown")
            owasp_counts[owasp] = owasp_counts.get(owasp, 0) + 1

        elapsed = time.time() - start_time

        result = {
            "success": True,
            "findings": findings,
            "finding_count": len(findings),
            "severity_counts": severity_counts,
            "owasp_counts": owasp_counts,
            "risk_score": risk_score,
            "risk_level": self._risk_level(risk_score),
            "scan_profile": scan_profile,
            "categories_scanned": categories,
            "processing_time": round(elapsed, 3),
        }

        self._scan_history.append(result)
        return result

    async def audit_security(
        self,
        target: Dict[str, Any],
        scope: str = "full",
    ) -> Dict[str, Any]:
        """Perform a comprehensive security audit.

        Args:
            target: Target configuration and metadata.
            scope: Audit scope (full, authentication, configuration, data, network).

        Returns:
            Security audit results with recommendations.
        """
        start_time = time.time()
        self.logger.info("Security audit: scope=%s, target=%s", scope, target.get("name", "unnamed"))

        findings = []
        recommendations = []

        # Authentication audit
        if scope in ("full", "authentication"):
            auth_findings = self._audit_authentication(target)
            findings.extend(auth_findings)

        # Configuration audit
        if scope in ("full", "configuration"):
            config_findings = self._audit_configuration(target)
            findings.extend(config_findings)

        # Data protection audit
        if scope in ("full", "data"):
            data_findings = self._audit_data_protection(target)
            findings.extend(data_findings)

        # Generate recommendations
        recommendations = self._generate_recommendations(findings)

        risk_score = self._compute_risk_score(findings)
        elapsed = time.time() - start_time

        return {
            "success": True,
            "scope": scope,
            "findings": findings,
            "recommendations": recommendations,
            "risk_score": risk_score,
            "risk_level": self._risk_level(risk_score),
            "processing_time": round(elapsed, 3),
        }

    async def threat_analysis(
        self,
        context: Dict[str, Any],
        assets: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Analyze threats and produce a threat model.

        Args:
            context: System context and architecture information.
            assets: List of assets to protect.

        Returns:
            Threat analysis with identified threats and mitigations.
        """
        start_time = time.time()
        self.logger.info("Threat analysis: assets=%d", len(assets or []))

        assets = assets or []
        threats = []

        # Analyze each asset for potential threats
        for asset in assets:
            asset_type = asset.get("type", "unknown")
            asset_name = asset.get("name", "unnamed")

            # Common threat categories
            threat_categories = self._get_threat_categories(asset_type)

            for threat_cat in threat_categories:
                threat = {
                    "asset": asset_name,
                    "asset_type": asset_type,
                    "threat_type": threat_cat["type"],
                    "description": threat_cat["description"],
                    "likelihood": threat_cat["likelihood"],
                    "impact": threat_cat["impact"],
                    "risk": self._assess_risk(threat_cat["likelihood"], threat_cat["impact"]),
                    "mitigation": threat_cat["mitigation"],
                }
                threats.append(threat)

        # Rank threats by risk
        threats.sort(key=lambda t: t["risk"], reverse=True)

        elapsed = time.time() - start_time

        return {
            "success": True,
            "threats": threats,
            "threat_count": len(threats),
            "high_risk_count": len([t for t in threats if t["risk"] >= 7]),
            "context": context,
            "processing_time": round(elapsed, 3),
        }

    # -------------------------------------------------------------------
    # Audit Helpers
    # -------------------------------------------------------------------

    def _audit_authentication(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Audit authentication configuration."""
        findings = []

        auth_config = target.get("authentication", {})
        if not auth_config:
            findings.append({
                "category": "authentication",
                "severity": "high",
                "message": "No authentication configuration found",
                "recommendation": "Implement authentication for all protected endpoints",
            })
            return findings

        # Check for MFA
        if not auth_config.get("mfa_enabled", False):
            findings.append({
                "category": "authentication",
                "severity": "medium",
                "message": "Multi-factor authentication not enabled",
                "recommendation": "Enable MFA for all administrative access",
            })

        # Check password policy
        password_policy = auth_config.get("password_policy", {})
        if not password_policy.get("min_length", 0) >= 12:
            findings.append({
                "category": "authentication",
                "severity": "medium",
                "message": "Password minimum length less than 12 characters",
                "recommendation": "Enforce minimum password length of 12+ characters",
            })

        # Check session management
        session_config = auth_config.get("session", {})
        if session_config.get("timeout", 0) > 7200:
            findings.append({
                "category": "authentication",
                "severity": "medium",
                "message": "Session timeout exceeds 2 hours",
                "recommendation": "Reduce session timeout to 2 hours or less",
            })

        return findings

    def _audit_configuration(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Audit system configuration."""
        findings = []

        config = target.get("configuration", {})

        # Check for debug mode
        if config.get("debug", False):
            findings.append({
                "category": "configuration",
                "severity": "high",
                "message": "Debug mode is enabled",
                "recommendation": "Disable debug mode in production environments",
            })

        # Check CORS configuration
        cors = config.get("cors", {})
        if "*" in cors.get("origins", []):
            findings.append({
                "category": "configuration",
                "severity": "medium",
                "message": "CORS allows all origins",
                "recommendation": "Restrict CORS to specific trusted domains",
            })

        # Check TLS
        if not config.get("tls_enabled", True):
            findings.append({
                "category": "configuration",
                "severity": "critical",
                "message": "TLS/HTTPS not enabled",
                "recommendation": "Enable TLS for all communications",
            })

        return findings

    def _audit_data_protection(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Audit data protection measures."""
        findings = []

        data_config = target.get("data_protection", {})

        # Check encryption at rest
        if not data_config.get("encryption_at_rest", False):
            findings.append({
                "category": "data_protection",
                "severity": "high",
                "message": "Encryption at rest not enabled",
                "recommendation": "Enable encryption for all stored sensitive data",
            })

        # Check encryption in transit
        if not data_config.get("encryption_in_transit", True):
            findings.append({
                "category": "data_protection",
                "severity": "critical",
                "message": "Encryption in transit not enforced",
                "recommendation": "Enforce TLS for all data transmission",
            })

        # Check PII handling
        if not data_config.get("pii_handling", False):
            findings.append({
                "category": "data_protection",
                "severity": "medium",
                "message": "No PII handling policy defined",
                "recommendation": "Define and implement PII handling and data retention policies",
            })

        return findings

    def _generate_recommendations(self, findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Generate prioritized recommendations from findings."""
        recommendations = []

        # Group by severity
        by_severity: Dict[str, List[Dict[str, Any]]] = {}
        for f in findings:
            sev = f.get("severity", "info")
            by_severity.setdefault(sev, []).append(f)

        # Generate recommendations for high/critical findings
        for sev in ("critical", "high", "medium"):
            for f in by_severity.get(sev, []):
                rec = {
                    "priority": sev,
                    "category": f.get("category", "unknown"),
                    "description": f.get("recommendation", f.get("message", "")),
                    "finding": f.get("message", ""),
                }
                recommendations.append(rec)

        return recommendations

    def _get_threat_categories(self, asset_type: str) -> List[Dict[str, Any]]:
        """Get applicable threat categories for an asset type."""
        common_threats = [
            {"type": "unauthorized_access", "description": "Unauthorized access to asset",
             "likelihood": 3, "impact": 8, "mitigation": "Implement strong authentication and RBAC"},
            {"type": "data_breach", "description": "Data breach through vulnerability",
             "likelihood": 2, "impact": 9, "mitigation": "Encrypt data at rest and in transit"},
            {"type": "dos", "description": "Denial of service attack",
             "likelihood": 4, "impact": 6, "mitigation": "Implement rate limiting and auto-scaling"},
        ]

        if asset_type in ("database", "data_store"):
            common_threats.append({
                "type": "sql_injection", "description": "SQL injection attack",
                "likelihood": 3, "impact": 9, "mitigation": "Use parameterized queries and input validation",
            })

        if asset_type in ("api", "web_service"):
            common_threats.append({
                "type": "api_abuse", "description": "API abuse or scraping",
                "likelihood": 5, "impact": 4, "mitigation": "Implement rate limiting and API key rotation",
            })

        return common_threats

    def _assess_risk(self, likelihood: int, impact: int) -> int:
        """Assess risk level from likelihood and impact (1-10 scale)."""
        return min(10, (likelihood * impact) // 10)

    def _compute_risk_score(self, findings: List[Dict[str, Any]]) -> float:
        """Compute overall risk score from findings.

        Returns:
            Risk score from 0 (safe) to 100 (critical).
        """
        if not findings:
            return 0.0

        severity_weights = {
            "info": 1, "low": 2, "warning": 5,
            "medium": 10, "high": 20, "critical": 40,
        }

        total_weight = sum(
            severity_weights.get(f.get("severity", "info"), 1) for f in findings
        )
        max_possible = len(findings) * 40

        return round(total_weight / max(max_possible, 1) * 100, 1) if max_possible else 0.0

    def _risk_level(self, score: float) -> str:
        """Convert risk score to risk level label."""
        if score <= 10:
            return "low"
        elif score <= 30:
            return "medium"
        elif score <= 60:
            return "high"
        else:
            return "critical"

    def mark_false_positive(self, finding_type: str) -> None:
        """Mark a finding type as false positive.

        Args:
            finding_type: The type/name of the finding to mark.
        """
        self._false_positive_tracker[finding_type] = self._false_positive_tracker.get(finding_type, 0) + 1

    def get_scan_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent scan history."""
        return self._scan_history[-limit:]
