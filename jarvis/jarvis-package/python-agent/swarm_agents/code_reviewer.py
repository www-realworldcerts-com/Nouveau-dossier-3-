"""JARVIS Swarm Agent - Code Reviewer

Specialized agent for code review, pattern analysis, and best practices checking.
Supports multiple programming languages and provides actionable recommendations.
"""
import logging
import re
import time
from typing import Any, Dict, List, Optional

from .base_agent import BaseAgent, AgentStatus

logger = logging.getLogger("jarvis.swarm.code_reviewer")


class CodeReviewerAgent(BaseAgent):
    """Agent specialized in code review and quality analysis.

    Capabilities:
    - Static code analysis
    - Pattern detection (anti-patterns, code smells)
    - Best practices validation
    - Complexity analysis
    - Style and formatting review
    - Security-oriented code review

    Attributes:
        supported_languages: List of supported programming languages.
        severity_threshold: Minimum severity level to report (info, warning, error).
    """

    # Language-specific comment patterns
    COMMENT_PATTERNS = {
        "python": r"#.*$|\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?'''",
        "javascript": r"//.*$|/\*[\s\S]*?\*/",
        "typescript": r"//.*$|/\*[\s\S]*?\*/",
        "java": r"//.*$|/\*[\s\S]*?\*/",
        "go": r"//.*$|/\*[\s\S]*?\*/",
        "rust": r"//.*$|/\*[\s\S]*?\*/",
        "ruby": r"#.*$|=begin[\s\S]*?=end",
        "php": r"//.*$|#.*$|/\*[\s\S]*?\*/",
    }

    # Anti-pattern definitions
    ANTI_PATTERNS = {
        "python": [
            {"pattern": r"except\s*:", "name": "Bare except", "severity": "warning",
             "message": "Bare except catches all exceptions including KeyboardInterrupt"},
            {"pattern": r"except\s+Exception\s*:", "name": "Broad exception", "severity": "info",
             "message": "Catching broad Exception; consider catching specific exceptions"},
            {"pattern": r"globals\(\)", "name": "Globals usage", "severity": "warning",
             "message": "Using globals() is a code smell and makes code hard to debug"},
            {"pattern": r"import\s+\*", "name": "Wildcard import", "severity": "warning",
             "message": "Wildcard imports pollute namespace and make dependencies unclear"},
            {"pattern": r"eval\s*\(", "name": "Eval usage", "severity": "error",
             "message": "eval() is dangerous and should be avoided"},
            {"pattern": r"exec\s*\(", "name": "Exec usage", "severity": "error",
             "message": "exec() is dangerous and should be avoided"},
            {"pattern": r"print\s*\(", "name": "Print statement", "severity": "info",
             "message": "Use logging instead of print statements in production code"},
            {"pattern": r"TODO|FIXME|HACK|XXX", "name": "Code annotation", "severity": "info",
             "message": "Code contains TODO/FIXME/HACK annotations"},
            {"pattern": r"pass\s*$", "name": "Empty block", "severity": "warning",
             "message": "Empty code block with pass statement"},
        ],
        "javascript": [
            {"pattern": r"console\.log\s*\(", "name": "Console log", "severity": "info",
             "message": "Console.log should be replaced with proper logging in production"},
            {"pattern": r"var\s+", "name": "Var usage", "severity": "warning",
             "message": "Use let/const instead of var for block scoping"},
            {"pattern": r"==(?!=)", "name": "Loose equality", "severity": "warning",
             "message": "Use === for strict equality comparison"},
            {"pattern": r"eval\s*\(", "name": "Eval usage", "severity": "error",
             "message": "eval() is dangerous and should be avoided"},
            {"pattern": r"innerHTML\s*=", "name": "InnerHTML assignment", "severity": "warning",
             "message": "innerHTML can lead to XSS vulnerabilities"},
        ],
        "generic": [
            {"pattern": r"password\s*=\s*['\"]", "name": "Hardcoded password", "severity": "error",
             "message": "Hardcoded password detected - use environment variables or secrets manager"},
            {"pattern": r"api_key\s*=\s*['\"]", "name": "Hardcoded API key", "severity": "error",
             "message": "Hardcoded API key detected - use environment variables or secrets manager"},
            {"pattern": r"secret\s*=\s*['\"]", "name": "Hardcoded secret", "severity": "error",
             "message": "Hardcoded secret detected - use environment variables or secrets manager"},
        ],
    }

    # Complexity indicators
    COMPLEXITY_PATTERNS = {
        "python": {
            "nested_if": r"if\s+.*:\s*\n(\s+)if\s+",
            "deep_nesting": r"^(\s{4,})",
            "long_function": None,  # Checked by line count
        },
    }

    def __init__(
        self,
        agent_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(
            agent_id=agent_id,
            name="CodeReviewer",
            description="Analyzes code for quality, patterns, best practices, and potential issues",
            config=config,
        )
        self.supported_languages = list(self.ANTI_PATTERNS.keys())
        self.severity_threshold = self.config.get("severity_threshold", "info")
        self.max_file_size = self.config.get("max_file_size", 1000000)
        self._review_history: List[Dict[str, Any]] = []

    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a code review task.

        Args:
            task: Task dict with 'type' and relevant parameters.

        Returns:
            Review result with findings and recommendations.
        """
        task_type = task.get("type", "analyze_code")

        if task_type == "analyze_code":
            return await self.analyze_code(
                code=task.get("code", ""),
                language=task.get("language", "python"),
                filename=task.get("filename", "unknown"),
            )
        elif task_type == "review_patterns":
            return await self.review_patterns(
                code=task.get("code", ""),
                language=task.get("language", "python"),
            )
        elif task_type == "check_best_practices":
            return await self.check_best_practices(
                code=task.get("code", ""),
                language=task.get("language", "python"),
            )
        else:
            return {"success": False, "error": f"Unknown task type: {task_type}"}

    def get_capabilities(self) -> List[Dict[str, Any]]:
        """Return agent capabilities."""
        return [
            {
                "name": "analyze_code",
                "description": "Perform comprehensive code analysis including quality, complexity, and security",
                "parameters": {
                    "code": {"type": "string", "required": True, "description": "Source code to analyze"},
                    "language": {"type": "string", "required": False, "default": "python"},
                    "filename": {"type": "string", "required": False},
                },
            },
            {
                "name": "review_patterns",
                "description": "Detect anti-patterns and code smells in the provided code",
                "parameters": {
                    "code": {"type": "string", "required": True},
                    "language": {"type": "string", "required": False, "default": "python"},
                },
            },
            {
                "name": "check_best_practices",
                "description": "Validate code against language-specific best practices",
                "parameters": {
                    "code": {"type": "string", "required": True},
                    "language": {"type": "string", "required": False, "default": "python"},
                },
            },
        ]

    async def analyze_code(
        self,
        code: str,
        language: str = "python",
        filename: str = "unknown",
    ) -> Dict[str, Any]:
        """Perform comprehensive code analysis.

        Args:
            code: Source code to analyze.
            language: Programming language.
            filename: File name for context.

        Returns:
            Analysis results with findings, metrics, and recommendations.
        """
        start_time = time.time()
        self.logger.info("Analyzing code: %s (%s, %d chars)", filename, language, len(code))

        if not code.strip():
            return {
                "success": False,
                "error": "Empty code provided",
                "filename": filename,
            }

        if len(code) > self.max_file_size:
            return {
                "success": False,
                "error": f"Code exceeds maximum size ({self.max_file_size} chars)",
                "filename": filename,
            }

        # Run all analysis components
        findings = []
        metrics = {}

        # Pattern review
        pattern_result = await self.review_patterns(code, language)
        if pattern_result.get("success"):
            findings.extend(pattern_result.get("findings", []))

        # Best practices check
        bp_result = await self.check_best_practices(code, language)
        if bp_result.get("success"):
            findings.extend(bp_result.get("findings", []))
            metrics.update(bp_result.get("metrics", {}))

        # Compute basic metrics
        lines = code.split("\n")
        code_lines = [l for l in lines if l.strip() and not self._is_comment(l, language)]
        comment_lines = [l for l in lines if self._is_comment(l, language)]
        blank_lines = [l for l in lines if not l.strip()]

        metrics["total_lines"] = len(lines)
        metrics["code_lines"] = len(code_lines)
        metrics["comment_lines"] = len(comment_lines)
        metrics["blank_lines"] = len(blank_lines)
        metrics["comment_ratio"] = round(len(comment_lines) / max(len(lines), 1), 2)

        # Compute average line length
        if code_lines:
            metrics["avg_line_length"] = round(
                sum(len(l) for l in code_lines) / len(code_lines), 1
            )
        else:
            metrics["avg_line_length"] = 0

        # Categorize findings by severity
        severity_counts = {"error": 0, "warning": 0, "info": 0}
        for finding in findings:
            severity = finding.get("severity", "info")
            severity_counts[severity] = severity_counts.get(severity, 0) + 1

        # Compute overall score (0-100)
        score = self._compute_score(metrics, severity_counts)

        elapsed = time.time() - start_time

        result = {
            "success": True,
            "filename": filename,
            "language": language,
            "findings": findings,
            "metrics": metrics,
            "severity_counts": severity_counts,
            "score": score,
            "processing_time": round(elapsed, 3),
        }

        self._review_history.append(result)
        return result

    async def review_patterns(
        self,
        code: str,
        language: str = "python",
    ) -> Dict[str, Any]:
        """Detect anti-patterns and code smells.

        Args:
            code: Source code to review.
            language: Programming language.

        Returns:
            Pattern review results with findings.
        """
        findings = []

        # Get patterns for the specific language and generic patterns
        patterns = []
        if language in self.ANTI_PATTERNS:
            patterns.extend(self.ANTI_PATTERNS[language])
        patterns.extend(self.ANTI_PATTERNS.get("generic", []))

        for pattern_def in patterns:
            try:
                matches = re.finditer(pattern_def["pattern"], code, re.MULTILINE)
                for match in matches:
                    # Find line number
                    line_num = code[:match.start()].count("\n") + 1
                    line_content = code.split("\n")[line_num - 1].strip() if line_num <= len(code.split("\n")) else ""

                    finding = {
                        "type": "anti_pattern",
                        "name": pattern_def["name"],
                        "severity": pattern_def["severity"],
                        "message": pattern_def["message"],
                        "line": line_num,
                        "line_content": line_content[:100],
                    }

                    # Filter by severity threshold
                    if self._passes_severity_threshold(pattern_def["severity"]):
                        findings.append(finding)

            except re.error:
                self.logger.warning("Invalid regex pattern: %s", pattern_def["pattern"])

        # Check for long lines
        for i, line in enumerate(code.split("\n"), 1):
            if len(line) > 120:
                if self._passes_severity_threshold("info"):
                    findings.append({
                        "type": "style",
                        "name": "Long line",
                        "severity": "info",
                        "message": f"Line exceeds 120 characters ({len(line)} chars)",
                        "line": i,
                        "line_content": line.strip()[:100],
                    })

        # Check for trailing whitespace
        for i, line in enumerate(code.split("\n"), 1):
            if line != line.rstrip():
                if self._passes_severity_threshold("info"):
                    findings.append({
                        "type": "style",
                        "name": "Trailing whitespace",
                        "severity": "info",
                        "message": "Line has trailing whitespace",
                        "line": i,
                    })

        return {
            "success": True,
            "findings": findings,
            "total_patterns_checked": len(patterns),
        }

    async def check_best_practices(
        self,
        code: str,
        language: str = "python",
    ) -> Dict[str, Any]:
        """Validate code against language-specific best practices.

        Args:
            code: Source code to check.
            language: Programming language.

        Returns:
            Best practices check results.
        """
        findings = []
        metrics = {}

        lines = code.split("\n")

        if language == "python":
            # Check for type hints in function definitions
            func_defs = re.findall(r"def\s+\w+\s*\([^)]*\)", code)
            typed_funcs = re.findall(r"def\s+\w+\s*\([^)]*:\s*\w+[^)]*\)\s*->", code)
            metrics["function_count"] = len(func_defs)
            metrics["typed_function_count"] = len(typed_funcs)
            metrics["type_hint_coverage"] = round(
                len(typed_funcs) / max(len(func_defs), 1), 2
            )

            if len(func_defs) > 0 and len(typed_funcs) < len(func_defs) * 0.5:
                findings.append({
                    "type": "best_practice",
                    "name": "Low type hint coverage",
                    "severity": "info",
                    "message": f"Only {len(typed_funcs)}/{len(func_defs)} functions have type hints ({metrics['type_hint_coverage']*100:.0f}%)",
                })

            # Check for docstrings
            docstrings = re.findall(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'', code)
            metrics["docstring_count"] = len(docstrings)
            metrics["docstring_coverage"] = round(
                len(docstrings) / max(len(func_defs), 1), 2
            )

            # Check for magic numbers
            magic_numbers = re.findall(r'(?<!self\.)(?<!["\'])\b\d{2,}\b', code)
            magic_numbers = [n for n in magic_numbers if n not in ("0", "1", "2", "10", "100")]
            if magic_numbers:
                findings.append({
                    "type": "best_practice",
                    "name": "Magic numbers",
                    "severity": "info",
                    "message": f"Found {len(magic_numbers)} potential magic numbers - consider using named constants",
                })

            # Check function length
            for func_match in re.finditer(r"def\s+(\w+)\s*\([^)]*\)\s*(?:->\s*\w+\s*)?:", code):
                func_name = func_match.group(1)
                func_start = code[:func_match.start()].count("\n") + 1
                # Estimate function length by indentation
                remaining = code[func_match.end():]
                func_lines = 0
                for line in remaining.split("\n"):
                    if line.strip() and not line.startswith(" ") and not line.startswith("\t"):
                        break
                    func_lines += 1
                    if func_lines > 50:
                        break

                if func_lines > 30:
                    findings.append({
                        "type": "best_practice",
                        "name": "Long function",
                        "severity": "warning",
                        "message": f"Function '{func_name}' is approximately {func_lines} lines (recommended max: 30)",
                        "line": func_start,
                    })

        elif language in ("javascript", "typescript"):
            # Check for modern JS practices
            func_defs = re.findall(r"(function\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)", code)
            metrics["function_count"] = len(func_defs)

            var_usage = len(re.findall(r"\bvar\s+", code))
            let_usage = len(re.findall(r"\blet\s+", code))
            const_usage = len(re.findall(r"\bconst\s+", code))

            metrics["var_count"] = var_usage
            metrics["let_count"] = let_usage
            metrics["const_count"] = const_usage

            if var_usage > 0:
                findings.append({
                    "type": "best_practice",
                    "name": "Var usage",
                    "severity": "warning",
                    "message": f"Found {var_usage} 'var' declarations - prefer 'let' or 'const'",
                })

        # Common best practices for all languages
        # Check file length
        if len(lines) > 300:
            findings.append({
                "type": "best_practice",
                "name": "Long file",
                "severity": "warning",
                "message": f"File has {len(lines)} lines - consider splitting into modules",
            })

        return {
            "success": True,
            "findings": findings,
            "metrics": metrics,
        }

    def _is_comment(self, line: str, language: str) -> bool:
        """Check if a line is a comment.

        Args:
            line: Source code line.
            language: Programming language.

        Returns:
            True if the line is a comment.
        """
        stripped = line.strip()
        if language in ("python", "ruby"):
            return stripped.startswith("#")
        elif language in ("javascript", "typescript", "java", "go", "rust", "php"):
            return stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*")
        return False

    def _passes_severity_threshold(self, severity: str) -> bool:
        """Check if a severity level passes the configured threshold.

        Args:
            severity: Finding severity level.

        Returns:
            True if the finding should be reported.
        """
        levels = {"info": 0, "warning": 1, "error": 2}
        threshold_level = levels.get(self.severity_threshold, 0)
        finding_level = levels.get(severity, 0)
        return finding_level >= threshold_level

    def _compute_score(
        self,
        metrics: Dict[str, Any],
        severity_counts: Dict[str, int],
    ) -> int:
        """Compute an overall code quality score.

        Args:
            metrics: Code metrics dictionary.
            severity_counts: Count of findings by severity.

        Returns:
            Score from 0 to 100.
        """
        score = 100

        # Deduct for errors
        score -= severity_counts.get("error", 0) * 10
        # Deduct for warnings
        score -= severity_counts.get("warning", 0) * 3
        # Deduct for info findings
        score -= severity_counts.get("info", 0) * 0.5

        # Bonus for good comment ratio
        comment_ratio = metrics.get("comment_ratio", 0)
        if 0.1 <= comment_ratio <= 0.3:
            score += 5
        elif comment_ratio < 0.05:
            score -= 5

        return max(0, min(100, int(score)))

    def get_review_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent review history.

        Args:
            limit: Maximum number of reviews to return.

        Returns:
            List of recent review results.
        """
        return self._review_history[-limit:]
