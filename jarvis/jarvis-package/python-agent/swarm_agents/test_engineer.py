"""JARVIS Swarm Agent - Test Engineer

Specialized agent for test generation, coverage analysis, and regression testing.
Supports multiple testing frameworks and generates comprehensive test suites.
"""
import logging
import re
import time
from typing import Any, Dict, List, Optional

from .base_agent import BaseAgent, AgentStatus

logger = logging.getLogger("jarvis.swarm.test_engineer")


class TestEngineerAgent(BaseAgent):
    """Agent specialized in test generation and quality assurance.

    Capabilities:
    - Unit test generation from source code
    - Test coverage analysis and gap detection
    - Regression test suite management
    - Integration test scaffolding
    - Test data generation
    - Assertion generation
    - Edge case identification

    Attributes:
        supported_frameworks: Testing frameworks this agent can generate tests for.
        test_templates: Pre-built test templates for common patterns.
    """

    SUPPORTED_FRAMEWORKS = {
        "python": ["pytest", "unittest"],
        "javascript": ["jest", "mocha"],
        "typescript": ["jest", "vitest"],
        "java": ["junit5", "testng"],
        "go": ["testing"],
        "rust": ["built-in"],
    }

    # Python test templates
    TEST_TEMPLATES = {
        "function_test": '''def test_{function_name}():
    """Test {function_name} function."""
    # Arrange
    {arrange}
    # Act
    result = {function_name}({args})
    # Assert
    {assertions}
''',
        "class_test": '''class Test{ClassName}:
    """Tests for {ClassName} class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.instance = {ClassName}({setup_args})

    def test_{method_name}(self):
        """Test {method_name} method."""
        result = self.instance.{method_name}({args})
        {assertions}
''',
        "exception_test": '''def test_{function_name}_raises_{exception}():
    """Test {function_name} raises {exception}."""
    with pytest.raises({exception}):
        {function_name}({args})
''',
        "parametrize_test": '''@pytest.mark.parametrize("input_val,expected", [
    ({input_cases},
])
def test_{function_name}_parametrized(input_val, expected):
    """Test {function_name} with multiple inputs."""
    result = {function_name}(input_val)
    assert result == expected
''',
        "async_test": '''@pytest.mark.asyncio
async def test_{function_name}_async():
    """Test async {function_name} function."""
    result = await {function_name}({args})
    {assertions}
''',
        "mock_test": '''def test_{function_name}_with_mock(mocker):
    """Test {function_name} with mocked dependencies."""
    mock_dep = mocker.patch("{mock_path}")
    mock_dep.return_value = {mock_return}
    result = {function_name}({args})
    {assertions}
    mock_dep.assert_called_once()
''',
    }

    def __init__(
        self,
        agent_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(
            agent_id=agent_id,
            name="TestEngineer",
            description="Generates tests, analyzes coverage, and manages regression test suites",
            config=config,
        )
        self.default_framework = self.config.get("default_framework", "pytest")
        self._generated_tests: List[Dict[str, Any]] = []
        self._coverage_reports: List[Dict[str, Any]] = []

    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a test engineering task.

        Args:
            task: Task dict with 'type' and relevant parameters.

        Returns:
            Task result with generated tests or analysis.
        """
        task_type = task.get("type", "generate_tests")

        if task_type == "generate_tests":
            return await self.generate_tests(
                code=task.get("code", ""),
                language=task.get("language", "python"),
                framework=task.get("framework", self.default_framework),
                test_types=task.get("test_types", ["unit"]),
            )
        elif task_type == "analyze_coverage":
            return await self.analyze_coverage(
                source_code=task.get("source_code", ""),
                test_code=task.get("test_code", ""),
                language=task.get("language", "python"),
            )
        elif task_type == "regression_test":
            return await self.regression_test(
                code=task.get("code", ""),
                previous_version=task.get("previous_version", ""),
                language=task.get("language", "python"),
            )
        else:
            return {"success": False, "error": f"Unknown task type: {task_type}"}

    def get_capabilities(self) -> List[Dict[str, Any]]:
        """Return agent capabilities."""
        return [
            {
                "name": "generate_tests",
                "description": "Generate test cases from source code",
                "parameters": {
                    "code": {"type": "string", "required": True, "description": "Source code to generate tests for"},
                    "language": {"type": "string", "required": False, "default": "python"},
                    "framework": {"type": "string", "required": False, "default": "pytest"},
                    "test_types": {"type": "array", "required": False, "default": ["unit"]},
                },
            },
            {
                "name": "analyze_coverage",
                "description": "Analyze test coverage and identify gaps",
                "parameters": {
                    "source_code": {"type": "string", "required": True},
                    "test_code": {"type": "string", "required": True},
                    "language": {"type": "string", "required": False, "default": "python"},
                },
            },
            {
                "name": "regression_test",
                "description": "Generate regression tests for code changes",
                "parameters": {
                    "code": {"type": "string", "required": True},
                    "previous_version": {"type": "string", "required": True},
                    "language": {"type": "string", "required": False, "default": "python"},
                },
            },
        ]

    async def generate_tests(
        self,
        code: str,
        language: str = "python",
        framework: str = "pytest",
        test_types: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Generate test cases from source code.

        Args:
            code: Source code to generate tests for.
            language: Programming language.
            framework: Testing framework to target.
            test_types: Types of tests to generate (unit, integration, edge_case, exception).

        Returns:
            Generated test code and metadata.
        """
        start_time = time.time()
        test_types = test_types or ["unit"]

        self.logger.info("Generating tests: %d chars, language=%s, framework=%s",
                        len(code), language, framework)

        if not code.strip():
            return {"success": False, "error": "Empty code provided"}

        # Validate framework
        available_frameworks = self.SUPPORTED_FRAMEWORKS.get(language, [])
        if framework not in available_frameworks:
            framework = available_frameworks[0] if available_frameworks else "pytest"

        # Extract code structures
        functions = self._extract_functions(code, language)
        classes = self._extract_classes(code, language)

        # Generate tests
        test_code_parts = []
        test_metadata = []

        # Imports
        imports = self._generate_imports(code, language, framework)
        test_code_parts.append(imports)

        # Unit tests for functions
        if "unit" in test_types:
            for func in functions:
                func_tests = self._generate_function_tests(func, framework)
                test_code_parts.append(func_tests["code"])
                test_metadata.append(func_tests["metadata"])

        # Unit tests for class methods
        if "unit" in test_types:
            for cls in classes:
                cls_tests = self._generate_class_tests(cls, framework)
                test_code_parts.append(cls_tests["code"])
                test_metadata.append(cls_tests["metadata"])

        # Edge case tests
        if "edge_case" in test_types:
            edge_tests = self._generate_edge_case_tests(functions, framework)
            test_code_parts.append(edge_tests["code"])
            test_metadata.extend(edge_tests["metadata"])

        # Exception tests
        if "exception" in test_types:
            exc_tests = self._generate_exception_tests(functions, framework)
            test_code_parts.append(exc_tests["code"])
            test_metadata.extend(exc_tests["metadata"])

        test_code = "\n".join(test_code_parts)
        elapsed = time.time() - start_time

        result = {
            "success": True,
            "test_code": test_code,
            "framework": framework,
            "language": language,
            "test_count": len(test_metadata),
            "test_metadata": test_metadata,
            "structures_found": {
                "functions": len(functions),
                "classes": len(classes),
            },
            "processing_time": round(elapsed, 3),
        }

        self._generated_tests.append(result)
        return result

    async def analyze_coverage(
        self,
        source_code: str,
        test_code: str,
        language: str = "python",
    ) -> Dict[str, Any]:
        """Analyze test coverage and identify gaps.

        Args:
            source_code: Source code being tested.
            test_code: Test code to analyze.
            language: Programming language.

        Returns:
            Coverage analysis with gaps and recommendations.
        """
        start_time = time.time()
        self.logger.info("Analyzing coverage: source=%d chars, test=%d chars",
                        len(source_code), len(test_code))

        # Extract structures from source
        functions = self._extract_functions(source_code, language)
        classes = self._extract_classes(source_code, language)

        # Check which structures are referenced in tests
        covered_functions = []
        uncovered_functions = []
        covered_classes = []
        uncovered_classes = []

        for func in functions:
            func_name = func["name"]
            # Check if function name appears in test code
            if re.search(rf"\b{re.escape(func_name)}\b", test_code):
                covered_functions.append(func_name)
            else:
                uncovered_functions.append(func_name)

        for cls in classes:
            cls_name = cls["name"]
            if re.search(rf"\bTest{re.escape(cls_name)}\b|\b{re.escape(cls_name)}\b", test_code):
                covered_classes.append(cls_name)
            else:
                uncovered_classes.append(cls_name)

        # Compute coverage
        total_items = len(functions) + len(classes)
        covered_items = len(covered_functions) + len(covered_classes)

        if total_items > 0:
            coverage_percent = round(covered_items / total_items * 100, 1)
        else:
            coverage_percent = 100.0

        # Identify gaps
        gaps = []
        for func_name in uncovered_functions:
            gaps.append({
                "type": "function",
                "name": func_name,
                "recommendation": f"Add unit test for function '{func_name}'",
            })

        for cls_name in uncovered_classes:
            gaps.append({
                "type": "class",
                "name": cls_name,
                "recommendation": f"Add test class for '{cls_name}'",
            })

        # Check for edge case coverage
        has_edge_tests = bool(re.search(r"None|null|empty|0|border|edge|boundary", test_code, re.IGNORECASE))
        if not has_edge_tests:
            gaps.append({
                "type": "edge_case",
                "name": "Missing edge case tests",
                "recommendation": "Add tests for null, empty, and boundary values",
            })

        elapsed = time.time() - start_time

        result = {
            "success": True,
            "coverage_percent": coverage_percent,
            "total_items": total_items,
            "covered_items": covered_items,
            "covered_functions": covered_functions,
            "uncovered_functions": uncovered_functions,
            "covered_classes": covered_classes,
            "uncovered_classes": uncovered_classes,
            "gaps": gaps,
            "recommendations": [g["recommendation"] for g in gaps],
            "processing_time": round(elapsed, 3),
        }

        self._coverage_reports.append(result)
        return result

    async def regression_test(
        self,
        code: str,
        previous_version: str = "",
        language: str = "python",
    ) -> Dict[str, Any]:
        """Generate regression tests for code changes.

        Args:
            code: Current version of the code.
            previous_version: Previous version for comparison.
            language: Programming language.

        Returns:
            Regression test results with generated tests.
        """
        start_time = time.time()
        self.logger.info("Regression test analysis: language=%s", language)

        if not previous_version:
            # If no previous version, generate full test suite
            return await self.generate_tests(code, language)

        # Identify changes between versions
        changes = self._identify_changes(code, previous_version, language)

        # Generate targeted regression tests for changed code
        regression_tests = []
        for change in changes:
            change_type = change.get("type", "unknown")
            change_name = change.get("name", "unknown")

            if change_type == "function":
                test = self._generate_function_tests(change, self.default_framework)
                regression_tests.append(test)
            elif change_type == "class":
                test = self._generate_class_tests(change, self.default_framework)
                regression_tests.append(test)

        test_code = "\n".join(
            t.get("code", "") for t in regression_tests
        )

        elapsed = time.time() - start_time

        return {
            "success": True,
            "changes_detected": len(changes),
            "changes": changes,
            "regression_test_code": test_code,
            "test_count": len(regression_tests),
            "processing_time": round(elapsed, 3),
        }

    # -------------------------------------------------------------------
    # Code Structure Extraction
    # -------------------------------------------------------------------

    def _extract_functions(self, code: str, language: str) -> List[Dict[str, Any]]:
        """Extract function definitions from code."""
        functions = []

        if language == "python":
            pattern = r"def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^(]+?))?\s*:"
            for match in re.finditer(pattern, code):
                name = match.group(1)
                params = match.group(2).strip()
                return_type = match.group(3).strip() if match.group(3) else None

                # Parse parameters
                param_list = self._parse_python_params(params)

                functions.append({
                    "type": "function",
                    "name": name,
                    "params": param_list,
                    "return_type": return_type,
                    "is_async": bool(re.search(r"async\s+def\s+" + re.escape(name), code)),
                })

        elif language in ("javascript", "typescript"):
            pattern = r"(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>"
            for match in re.finditer(pattern, code):
                name = match.group(1) or match.group(3)
                params = match.group(2) or match.group(4) or ""
                functions.append({
                    "type": "function",
                    "name": name,
                    "params": [p.strip() for p in params.split(",") if p.strip()],
                })

        return functions

    def _extract_classes(self, code: str, language: str) -> List[Dict[str, Any]]:
        """Extract class definitions from code."""
        classes = []

        if language == "python":
            class_pattern = r"class\s+(\w+)(?:\(([^)]+)\))?\s*:"
            for match in re.finditer(class_pattern, code):
                name = match.group(1)
                parent = match.group(2).strip() if match.group(2) else None

                # Extract methods
                methods = []
                # Look for methods in the class body (simplified)
                method_pattern = r"def\s+(\w+)\s*\((?:self|cls),?\s*([^)]*)\)"
                remaining_code = code[match.end():]
                for method_match in re.finditer(method_pattern, remaining_code[:2000]):
                    method_name = method_match.group(1)
                    if method_name.startswith("_") and not method_name.startswith("__"):
                        continue  # Skip private methods
                    method_params = method_match.group(2).strip()
                    methods.append({
                        "name": method_name,
                        "params": [p.strip() for p in method_params.split(",") if p.strip()],
                    })

                classes.append({
                    "type": "class",
                    "name": name,
                    "parent": parent,
                    "methods": methods,
                })

        return classes

    def _parse_python_params(self, params_str: str) -> List[Dict[str, Any]]:
        """Parse Python function parameters."""
        params = []
        if not params_str.strip():
            return params

        for param in params_str.split(","):
            param = param.strip()
            if not param or param in ("self", "cls"):
                continue

            # Handle type annotations
            if ":" in param:
                parts = param.split(":", 1)
                name = parts[0].strip()
                type_hint = parts[1].strip().split("=")[0].strip()
            else:
                name = param.split("=")[0].strip()
                type_hint = None

            # Handle default values
            has_default = "=" in param
            default_value = param.split("=")[1].strip() if has_default else None

            params.append({
                "name": name,
                "type": type_hint,
                "has_default": has_default,
                "default": default_value,
            })

        return params

    # -------------------------------------------------------------------
    # Test Generation Helpers
    # -------------------------------------------------------------------

    def _generate_imports(self, code: str, language: str, framework: str) -> str:
        """Generate import statements for the test file."""
        if language == "python":
            imports = [
                '"""Auto-generated test suite by JARVIS TestEngineer Agent."""',
                "import pytest",
                "from unittest.mock import Mock, MagicMock, patch",
            ]
            # Try to extract the module name from the code
            module_match = re.search(r"^(\w+)", code.strip())
            if module_match:
                imports.append(f"from {module_match.group(1)} import *")
            return "\n".join(imports) + "\n\n"
        elif language in ("javascript", "typescript"):
            return '// Auto-generated test suite by JARVIS TestEngineer Agent\n\n'
        return ""

    def _generate_function_tests(self, func: Dict[str, Any], framework: str) -> Dict[str, Any]:
        """Generate test cases for a function."""
        func_name = func["name"]
        params = func.get("params", [])
        is_async = func.get("is_async", False)

        # Build test arguments
        args = []
        for p in params:
            if isinstance(p, dict):
                if p.get("has_default"):
                    args.append(p.get("default", "None"))
                elif p.get("type"):
                    args.append(self._get_type_default(p["type"]))
                else:
                    args.append("None")
            else:
                args.append("None")

        args_str = ", ".join(str(a) for a in args)

        # Select template
        if is_async:
            template = self.TEST_TEMPLATES["async_test"]
        else:
            template = self.TEST_TEMPLATES["function_test"]

        test_code = template.format(
            function_name=func_name,
            arrange="# TODO: Set up test data",
            args=args_str,
            assertions="assert result is not None  # TODO: Add specific assertions",
        )

        return {
            "code": test_code,
            "metadata": {
                "function": func_name,
                "test_type": "async" if is_async else "unit",
                "param_count": len(params),
            },
        }

    def _generate_class_tests(self, cls: Dict[str, Any], framework: str) -> Dict[str, Any]:
        """Generate test cases for a class."""
        cls_name = cls["name"]
        methods = cls.get("methods", [])

        test_parts = []

        # Generate class test header
        test_parts.append(f'class Test{cls_name}:')
        test_parts.append(f'    """Tests for {cls_name} class."""')
        test_parts.append('')
        test_parts.append('    def setup_method(self):')
        test_parts.append(f'        """Set up test fixtures."""')
        test_parts.append(f'        self.instance = {cls_name}()')
        test_parts.append('')

        # Generate a test for each public method
        for method in methods:
            method_name = method.get("name", "unknown")
            params = method.get("params", [])

            args = []
            for p in params:
                if isinstance(p, dict):
                    args.append(self._get_type_default(p.get("type", "")))
                else:
                    args.append("None")

            args_str = ", ".join(str(a) for a in args)

            test_parts.append(f'    def test_{method_name}(self):')
            test_parts.append(f'        """Test {method_name} method."""')
            test_parts.append(f'        result = self.instance.{method_name}({args_str})')
            test_parts.append(f'        assert result is not None  # TODO: Add specific assertions')
            test_parts.append('')

        test_code = "\n".join(test_parts) + "\n"

        return {
            "code": test_code,
            "metadata": {
                "class": cls_name,
                "test_type": "unit",
                "method_count": len(methods),
            },
        }

    def _generate_edge_case_tests(self, functions: List[Dict[str, Any]], framework: str) -> Dict[str, Any]:
        """Generate edge case tests for functions."""
        test_parts = []
        metadata = []

        for func in functions:
            func_name = func["name"]
            params = func.get("params", [])

            # Generate edge case test
            test_parts.append(f'def test_{func_name}_edge_cases():')
            test_parts.append(f'    """Test {func_name} with edge case inputs."""')

            # None input
            if params:
                test_parts.append(f'    # None input')
                test_parts.append(f'    try:')
                test_parts.append(f'        result = {func_name}(None)')
                test_parts.append(f'    except (TypeError, ValueError, AttributeError):')
                test_parts.append(f'        pass  # Expected to raise')
                test_parts.append('')

            # Empty input
            test_parts.append(f'    # Empty input')
            test_parts.append(f'    try:')
            empty_args = ", ".join(['""' if p.get("type") == "str" else "[]" for p in params] or ['""'])
            test_parts.append(f'        result = {func_name}({empty_args})')
            test_parts.append(f'    except (TypeError, ValueError):')
            test_parts.append(f'        pass  # Expected to raise')
            test_parts.append('')

        metadata.append({
            "test_type": "edge_case",
            "function_count": len(functions),
        })

        return {
            "code": "\n".join(test_parts) + "\n",
            "metadata": metadata,
        }

    def _generate_exception_tests(self, functions: List[Dict[str, Any]], framework: str) -> Dict[str, Any]:
        """Generate exception tests for functions."""
        test_parts = []
        metadata = []

        for func in functions:
            func_name = func["name"]
            params = func.get("params", [])

            # Generate exception test for invalid input
            test_parts.append(f'def test_{func_name}_invalid_input():')
            test_parts.append(f'    """Test {func_name} raises on invalid input."""')
            test_parts.append(f'    with pytest.raises((TypeError, ValueError)):')
            test_parts.append(f'        {func_name}("invalid_input")')
            test_parts.append('')

        metadata.append({
            "test_type": "exception",
            "function_count": len(functions),
        })

        return {
            "code": "\n".join(test_parts) + "\n",
            "metadata": metadata,
        }

    def _get_type_default(self, type_hint: str) -> str:
        """Get a default test value for a type hint."""
        type_defaults = {
            "str": '""',
            "int": "0",
            "float": "0.0",
            "bool": "False",
            "list": "[]",
            "dict": "{}",
            "tuple": "()",
            "set": "set()",
            "None": "None",
            "Optional": "None",
        }
        return type_defaults.get(type_hint, "None")

    def _identify_changes(self, code: str, previous: str, language: str) -> List[Dict[str, Any]]:
        """Identify changes between two code versions."""
        changes = []

        current_funcs = {f["name"]: f for f in self._extract_functions(code, language)}
        previous_funcs = {f["name"]: f for f in self._extract_functions(previous, language)}

        # New functions
        for name, func in current_funcs.items():
            if name not in previous_funcs:
                changes.append({"type": "function", "change": "added", **func})
            elif func != previous_funcs[name]:
                changes.append({"type": "function", "change": "modified", **func})

        # Removed functions
        for name in previous_funcs:
            if name not in current_funcs:
                changes.append({"type": "function", "change": "removed", "name": name})

        return changes

    def get_generated_tests(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recently generated test results."""
        return self._generated_tests[-limit:]

    def get_coverage_reports(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent coverage reports."""
        return self._coverage_reports[-limit:]
