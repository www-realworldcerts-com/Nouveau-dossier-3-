"""JARVIS Swarm Agent - Web Performance

Specialized agent for web performance auditing, Lighthouse-style analysis,
and optimization recommendations.
"""
import logging
import re
import time
from typing import Any, Dict, List, Optional

from .base_agent import BaseAgent, AgentStatus

logger = logging.getLogger("jarvis.swarm.web_performance")


class WebPerformanceAgent(BaseAgent):
    """Agent specialized in web performance auditing and optimization.

    Capabilities:
    - Performance scoring and auditing
    - Core Web Vitals analysis
    - Resource optimization recommendations
    - Bundle size analysis
    - Image optimization recommendations
    - Caching strategy recommendations
    - Lighthouse-style scoring

    Attributes:
        scoring_weights: Category weights for overall performance score.
    """

    # Performance scoring categories and weights
    SCORING_WEIGHTS = {
        "first_contentful_paint": 0.15,
        "largest_contentful_paint": 0.25,
        "cumulative_layout_shift": 0.15,
        "first_input_delay": 0.15,
        "total_blocking_time": 0.10,
        "speed_index": 0.10,
        "resource_optimization": 0.05,
        "caching": 0.05,
    }

    # Core Web Vitals thresholds (milliseconds / score)
    CORE_WEB_VITALS = {
        "largest_contentful_paint": {
            "good": 2500,     # ms
            "needs_improvement": 4000,
            "metric": "ms",
        },
        "first_input_delay": {
            "good": 100,
            "needs_improvement": 300,
            "metric": "ms",
        },
        "cumulative_layout_shift": {
            "good": 0.1,
            "needs_improvement": 0.25,
            "metric": "score",
        },
    }

    # Common performance anti-patterns in HTML/JS/CSS
    PERFORMANCE_ANTI_PATTERNS = {
        "render_blocking": [
            {"pattern": r"<link[^>]*rel=['\"]stylesheet['\"][^>]*>",
             "name": "Render-blocking stylesheet",
             "severity": "warning",
             "recommendation": "Use media attribute or load CSS asynchronously"},
            {"pattern": r"<script[^>]*src=['\"][^'\"]+['\"][^>]*>(?!<\/script>)",
             "name": "Render-blocking script",
             "severity": "warning",
             "recommendation": "Add async or defer attribute to non-critical scripts"},
        ],
        "image_optimization": [
            {"pattern": r"<img[^>]*(?!loading=)[^>]*>",
             "name": "Image without lazy loading",
             "severity": "info",
             "recommendation": "Add loading='lazy' to below-the-fold images"},
            {"pattern": r"<img[^>]*src=['\"][^'\"]+\.(png|jpg|jpeg)['\"][^>]*>",
             "name": "Unoptimized image format",
             "severity": "info",
             "recommendation": "Consider using WebP or AVIF format for better compression"},
            {"pattern": r"<img[^>]*(?!width=|height=)[^>]*>",
             "name": "Image without dimensions",
             "severity": "warning",
             "recommendation": "Set explicit width and height to prevent layout shifts"},
        ],
        "javascript": [
            {"pattern": r"document\.write\s*\(",
             "name": "document.write usage",
             "severity": "warning",
             "recommendation": "Avoid document.write() - it blocks parsing"},
            {"pattern": r"new\s+Date\(\)\.getTime\(\)",
             "name": "Legacy timing API",
             "severity": "info",
             "recommendation": "Use performance.now() for high-resolution timing"},
            {"pattern": r"window\.onload\s*=",
             "name": "window.onload assignment",
             "severity": "info",
             "recommendation": "Use DOMContentLoaded or addEventListener for better timing"},
            {"pattern": r"\.innerHTML\s*=",
             "name": "innerHTML manipulation",
             "severity": "info",
             "recommendation": "Consider using textContent or DOM manipulation for better performance"},
        ],
        "css": [
            {"pattern": r"@import\s+",
             "name": "CSS @import",
             "severity": "warning",
             "recommendation": "Avoid CSS @import - use link tags or bundle CSS"},
            {"pattern": r"!\s*important",
             "name": "!important usage",
             "severity": "info",
             "recommendation": "Minimize !important usage for maintainable CSS"},
            {"pattern": r"\*\s*\{",
             "name": "Universal selector",
             "severity": "info",
             "recommendation": "Avoid universal selectors for performance"},
        ],
        "caching": [
            {"pattern": r"Cache-Control:\s*no-cache|no-store",
             "name": "Aggressive cache busting",
             "severity": "warning",
             "recommendation": "Use appropriate cache headers for static assets"},
        ],
    }

    def __init__(
        self,
        agent_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(
            agent_id=agent_id,
            name="WebPerformance",
            description="Audits web performance, analyzes Core Web Vitals, and provides optimization recommendations",
            config=config,
        )
        self._audit_history: List[Dict[str, Any]] = []

    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a web performance task.

        Args:
            task: Task dict with 'type' and relevant parameters.

        Returns:
            Performance audit result.
        """
        task_type = task.get("type", "audit_performance")

        if task_type == "audit_performance":
            return await self.audit_performance(
                html=task.get("html", ""),
                css=task.get("css", ""),
                javascript=task.get("javascript", ""),
                url=task.get("url", ""),
                metrics=task.get("metrics", {}),
            )
        elif task_type == "lighthouse_analysis":
            return await self.lighthouse_analysis(
                html=task.get("html", ""),
                metrics=task.get("metrics", {}),
                url=task.get("url", ""),
            )
        elif task_type == "optimize":
            return await self.optimize(
                html=task.get("html", ""),
                css=task.get("css", ""),
                javascript=task.get("javascript", ""),
                target_score=task.get("target_score", 90),
            )
        else:
            return {"success": False, "error": f"Unknown task type: {task_type}"}

    def get_capabilities(self) -> List[Dict[str, Any]]:
        """Return agent capabilities."""
        return [
            {
                "name": "audit_performance",
                "description": "Perform a comprehensive web performance audit",
                "parameters": {
                    "html": {"type": "string", "required": False, "description": "HTML source to analyze"},
                    "css": {"type": "string", "required": False, "description": "CSS source to analyze"},
                    "javascript": {"type": "string", "required": False, "description": "JavaScript source to analyze"},
                    "url": {"type": "string", "required": False, "description": "URL to audit"},
                    "metrics": {"type": "object", "required": False, "description": "Pre-collected performance metrics"},
                },
            },
            {
                "name": "lighthouse_analysis",
                "description": "Perform Lighthouse-style analysis with scoring",
                "parameters": {
                    "html": {"type": "string", "required": False},
                    "metrics": {"type": "object", "required": False},
                    "url": {"type": "string", "required": False},
                },
            },
            {
                "name": "optimize",
                "description": "Generate optimization recommendations and code transforms",
                "parameters": {
                    "html": {"type": "string", "required": False},
                    "css": {"type": "string", "required": False},
                    "javascript": {"type": "string", "required": False},
                    "target_score": {"type": "integer", "required": False, "default": 90},
                },
            },
        ]

    async def audit_performance(
        self,
        html: str = "",
        css: str = "",
        javascript: str = "",
        url: str = "",
        metrics: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Perform a comprehensive web performance audit.

        Args:
            html: HTML source code.
            css: CSS source code.
            javascript: JavaScript source code.
            url: Target URL (for context).
            metrics: Pre-collected performance metrics.

        Returns:
            Audit results with findings, scores, and recommendations.
        """
        start_time = time.time()
        metrics = metrics or {}

        self.logger.info("Performance audit: html=%d chars, css=%d chars, js=%d chars",
                        len(html), len(css), len(javascript))

        findings = []
        all_code = f"{html}\n{css}\n{javascript}"

        # Scan for performance anti-patterns
        for category, patterns in self.PERFORMANCE_ANTI_PATTERNS.items():
            for pattern_def in patterns:
                try:
                    matches = list(re.finditer(pattern_def["pattern"], all_code, re.IGNORECASE))
                    if matches:
                        finding = {
                            "category": category,
                            "name": pattern_def["name"],
                            "severity": pattern_def["severity"],
                            "occurrences": len(matches),
                            "recommendation": pattern_def["recommendation"],
                        }
                        findings.append(finding)
                except re.error:
                    pass

        # Analyze resource sizes
        resource_analysis = self._analyze_resources(html, css, javascript)

        # Compute category scores
        category_scores = self._compute_category_scores(findings, metrics, resource_analysis)

        # Compute overall score
        overall_score = self._compute_overall_score(category_scores, metrics)

        # Analyze Core Web Vitals
        core_web_vitals = self._analyze_core_web_vitals(metrics)

        # Generate recommendations
        recommendations = self._generate_recommendations(findings, category_scores, core_web_vitals)

        elapsed = time.time() - start_time

        result = {
            "success": True,
            "url": url,
            "overall_score": overall_score,
            "category_scores": category_scores,
            "core_web_vitals": core_web_vitals,
            "findings": findings,
            "resource_analysis": resource_analysis,
            "recommendations": recommendations,
            "processing_time": round(elapsed, 3),
        }

        self._audit_history.append(result)
        return result

    async def lighthouse_analysis(
        self,
        html: str = "",
        metrics: Optional[Dict[str, Any]] = None,
        url: str = "",
    ) -> Dict[str, Any]:
        """Perform a Lighthouse-style analysis with scoring.

        Args:
            html: HTML source code.
            metrics: Pre-collected performance metrics.
            url: Target URL.

        Returns:
            Lighthouse-style audit result with scores across categories.
        """
        start_time = time.time()
        metrics = metrics or {}

        # Lighthouse-style categories
        categories = {
            "performance": self._score_performance(metrics),
            "accessibility": self._score_accessibility(html),
            "best_practices": self._score_best_practices(html, metrics),
            "seo": self._score_seo(html),
        }

        # Compute weighted overall score
        overall = (
            categories["performance"]["score"] * 0.40 +
            categories["accessibility"]["score"] * 0.20 +
            categories["best_practices"]["score"] * 0.20 +
            categories["seo"]["score"] * 0.20
        )

        elapsed = time.time() - start_time

        return {
            "success": True,
            "url": url,
            "overall_score": round(overall, 1),
            "categories": categories,
            "processing_time": round(elapsed, 3),
        }

    async def optimize(
        self,
        html: str = "",
        css: str = "",
        javascript: str = "",
        target_score: int = 90,
    ) -> Dict[str, Any]:
        """Generate optimization recommendations and code transformations.

        Args:
            html: HTML source code.
            css: CSS source code.
            javascript: JavaScript source code.
            target_score: Target performance score to achieve.

        Returns:
            Optimization plan with specific changes and expected score improvements.
        """
        start_time = time.time()

        # Run audit first to identify current state
        audit = await self.audit_performance(html, css, javascript)

        optimizations = []
        estimated_score = audit["overall_score"]

        # Generate optimizations based on findings
        for finding in audit.get("findings", []):
            optimization = {
                "category": finding["category"],
                "issue": finding["name"],
                "severity": finding["severity"],
                "recommendation": finding["recommendation"],
                "estimated_improvement": self._estimate_improvement(finding),
                "priority": self._prioritize_optimization(finding),
            }
            optimizations.append(optimization)
            estimated_score += optimization["estimated_improvement"]

        # Sort by priority
        optimizations.sort(key=lambda o: o["priority"], reverse=True)

        elapsed = time.time() - start_time

        return {
            "success": True,
            "current_score": audit["overall_score"],
            "target_score": target_score,
            "estimated_score_after": min(100, estimated_score),
            "optimizations": optimizations,
            "optimization_count": len(optimizations),
            "processing_time": round(elapsed, 3),
        }

    # -------------------------------------------------------------------
    # Analysis Helpers
    # -------------------------------------------------------------------

    def _analyze_resources(self, html: str, css: str, javascript: str) -> Dict[str, Any]:
        """Analyze resource sizes and counts."""
        # Count external resources
        scripts = re.findall(r"<script[^>]*src=['\"]([^'\"]+)['\"]", html)
        stylesheets = re.findall(r"<link[^>]*href=['\"]([^'\"]+\.css)['\"]", html)
        images = re.findall(r"<img[^>]*src=['\"]([^'\"]+)['\"]", html)
        fonts = re.findall(r"@font-face|<link[^>]*font", html + css)

        return {
            "html_size_bytes": len(html.encode("utf-8")),
            "css_size_bytes": len(css.encode("utf-8")),
            "js_size_bytes": len(javascript.encode("utf-8")),
            "external_scripts": len(scripts),
            "external_stylesheets": len(stylesheets),
            "images": len(images),
            "fonts": len(fonts),
            "total_requests": len(scripts) + len(stylesheets) + len(images),
        }

    def _compute_category_scores(
        self,
        findings: List[Dict[str, Any]],
        metrics: Dict[str, Any],
        resource_analysis: Dict[str, Any],
    ) -> Dict[str, float]:
        """Compute performance scores for each category."""
        scores = {
            "render_blocking": 100,
            "image_optimization": 100,
            "javascript": 100,
            "css": 100,
            "caching": 100,
        }

        # Deduct points for findings
        severity_deductions = {"critical": 30, "warning": 15, "info": 5}
        for finding in findings:
            category = finding.get("category", "")
            if category in scores:
                deduction = severity_deductions.get(finding["severity"], 5)
                scores[category] = max(0, scores[category] - deduction)

        # Adjust based on metrics if available
        if metrics.get("total_blocking_time", 0) > 600:
            scores["javascript"] = min(scores["javascript"], 50)

        if resource_analysis.get("total_requests", 0) > 50:
            scores["render_blocking"] = min(scores["render_blocking"], 60)

        return {k: round(v, 1) for k, v in scores.items()}

    def _compute_overall_score(
        self,
        category_scores: Dict[str, float],
        metrics: Dict[str, Any],
    ) -> float:
        """Compute overall performance score from category scores."""
        if not category_scores:
            return 100.0

        # Use metrics-based scoring if metrics are available
        if metrics:
            lcp = metrics.get("largest_contentful_paint", 2500)
            fcp = metrics.get("first_contentful_paint", 1800)
            cls = metrics.get("cumulative_layout_shift", 0.1)
            tbt = metrics.get("total_blocking_time", 200)
            si = metrics.get("speed_index", 3400)

            # Score each metric (0-100)
            lcp_score = max(0, 100 - (lcp - 2500) / 30) if lcp > 2500 else 100
            fcp_score = max(0, 100 - (fcp - 1800) / 20) if fcp > 1800 else 100
            cls_score = max(0, 100 - cls * 200) if cls > 0.1 else 100
            tbt_score = max(0, 100 - (tbt - 200) / 5) if tbt > 200 else 100
            si_score = max(0, 100 - (si - 3400) / 20) if si > 3400 else 100

            overall = (
                lcp_score * 0.25 +
                fcp_score * 0.15 +
                cls_score * 0.15 +
                tbt_score * 0.10 +
                si_score * 0.10 +
                sum(category_scores.values()) / len(category_scores) * 0.25
            )
            return round(overall, 1)

        # Otherwise use category scores average
        return round(sum(category_scores.values()) / len(category_scores), 1)

    def _analyze_core_web_vitals(self, metrics: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze Core Web Vitals from provided metrics."""
        vitals = {}

        for vital_name, thresholds in self.CORE_WEB_VITALS.items():
            value = metrics.get(vital_name)

            if value is not None:
                if value <= thresholds["good"]:
                    rating = "good"
                elif value <= thresholds["needs_improvement"]:
                    rating = "needs-improvement"
                else:
                    rating = "poor"

                vitals[vital_name] = {
                    "value": value,
                    "unit": thresholds["metric"],
                    "rating": rating,
                    "good_threshold": thresholds["good"],
                    "needs_improvement_threshold": thresholds["needs_improvement"],
                }
            else:
                vitals[vital_name] = {
                    "value": None,
                    "unit": thresholds["metric"],
                    "rating": "unknown",
                    "good_threshold": thresholds["good"],
                }

        return vitals

    def _generate_recommendations(
        self,
        findings: List[Dict[str, Any]],
        category_scores: Dict[str, float],
        core_web_vitals: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Generate prioritized optimization recommendations."""
        recommendations = []

        # Recommendations from findings
        for finding in findings:
            recommendations.append({
                "priority": "high" if finding["severity"] in ("critical", "warning") else "medium",
                "category": finding["category"],
                "description": finding["recommendation"],
                "issue": finding["name"],
            })

        # Recommendations from low category scores
        for category, score in category_scores.items():
            if score < 70:
                recommendations.append({
                    "priority": "high",
                    "category": category,
                    "description": f"{category} score is low ({score}/100). Focus optimization efforts here.",
                    "issue": f"Low {category} score",
                })

        # Recommendations from Core Web Vitals
        for vital_name, vital_data in core_web_vitals.items():
            if vital_data.get("rating") == "poor":
                recommendations.append({
                    "priority": "critical",
                    "category": "core_web_vitals",
                    "description": f"{vital_name} is poor ({vital_data['value']} {vital_data['unit']}). Target: < {vital_data['good_threshold']} {vital_data['unit']}",
                    "issue": f"Poor {vital_name}",
                })

        # Sort by priority
        priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        recommendations.sort(key=lambda r: priority_order.get(r["priority"], 99))

        return recommendations

    # -------------------------------------------------------------------
    # Lighthouse-style scoring helpers
    # -------------------------------------------------------------------

    def _score_performance(self, metrics: Dict[str, Any]) -> Dict[str, Any]:
        """Score performance category (Lighthouse-style)."""
        if not metrics:
            return {"score": 75.0, "description": "No metrics available - estimated score"}

        lcp = metrics.get("largest_contentful_paint", 3000)
        fcp = metrics.get("first_contentful_paint", 2000)
        cls = metrics.get("cumulative_layout_shift", 0.15)
        tbt = metrics.get("total_blocking_time", 300)

        # Simplified scoring
        score = 100
        score -= max(0, (lcp - 2500) / 50)
        score -= max(0, (fcp - 1800) / 40)
        score -= max(0, cls * 100)
        score -= max(0, (tbt - 200) / 10)

        return {"score": round(max(0, min(100, score)), 1), "metrics_used": bool(metrics)}

    def _score_accessibility(self, html: str) -> Dict[str, Any]:
        """Score accessibility category."""
        score = 100

        if not html:
            return {"score": 50.0, "description": "No HTML provided for analysis"}

        # Check for alt text on images
        images = re.findall(r"<img[^>]*>", html)
        images_without_alt = [img for img in images if "alt=" not in img]
        if images_without_alt:
            score -= len(images_without_alt) * 10

        # Check for ARIA labels
        if "aria-label" not in html and "aria-labelledby" not in html:
            score -= 10

        # Check for lang attribute
        if "lang=" not in html:
            score -= 10

        # Check for semantic elements
        semantic_tags = ["<main", "<nav", "<header", "<footer", "<section", "<article"]
        has_semantic = any(tag in html.lower() for tag in semantic_tags)
        if not has_semantic:
            score -= 10

        return {"score": round(max(0, score), 1)}

    def _score_best_practices(self, html: str, metrics: Dict[str, Any]) -> Dict[str, Any]:
        """Score best practices category."""
        score = 100

        if not html:
            return {"score": 70.0, "description": "No HTML provided"}

        # Check for HTTPS
        if "http://" in html and "localhost" not in html:
            score -= 20

        # Check for deprecated APIs
        if "document.write" in html:
            score -= 10

        # Check for console errors indicator
        if metrics.get("js_errors", 0) > 0:
            score -= 10

        return {"score": round(max(0, score), 1)}

    def _score_seo(self, html: str) -> Dict[str, Any]:
        """Score SEO category."""
        score = 100

        if not html:
            return {"score": 50.0, "description": "No HTML provided"}

        # Check for title tag
        if "<title>" not in html.lower():
            score -= 20

        # Check for meta description
        if "meta name=\"description\"" not in html.lower() and "meta name='description'" not in html.lower():
            score -= 15

        # Check for viewport meta
        if "viewport" not in html.lower():
            score -= 15

        # Check for heading structure
        if "<h1" not in html.lower():
            score -= 10

        # Check for canonical
        if "canonical" not in html.lower():
            score -= 5

        return {"score": round(max(0, score), 1)}

    def _estimate_improvement(self, finding: Dict[str, Any]) -> float:
        """Estimate score improvement from fixing a finding."""
        estimates = {
            "critical": 5.0,
            "warning": 3.0,
            "info": 1.0,
        }
        return estimates.get(finding.get("severity", "info"), 1.0)

    def _prioritize_optimization(self, finding: Dict[str, Any]) -> float:
        """Prioritize an optimization by impact."""
        priority = {
            "critical": 100,
            "warning": 50,
            "info": 10,
        }
        base = priority.get(finding.get("severity", "info"), 10)
        # Multiply by occurrences
        return base * finding.get("occurrences", 1)

    def get_audit_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent audit history."""
        return self._audit_history[-limit:]
