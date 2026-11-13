"""JARVIS Swarm Agent - Payment Agent

Specialized agent for payment processing, policy evaluation, and
transaction management with fraud detection.
"""
import logging
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from .base_agent import BaseAgent, AgentStatus

logger = logging.getLogger("jarvis.swarm.payment_agent")


class PaymentAgent(BaseAgent):
    """Agent specialized in payment processing and policy evaluation.

    Capabilities:
    - Payment processing with validation
    - Policy-based transaction evaluation
    - Fraud detection and risk scoring
    - Transaction management and tracking
    - Refund processing
    - Spending limit enforcement
    - Category-based access control

    Attributes:
        policies: Active payment policies.
        transaction_log: Record of all processed transactions.
    """

    # Transaction statuses
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_DECLINED = "declined"
    STATUS_FAILED = "failed"
    STATUS_REFUNDED = "refunded"
    STATUS_CANCELLED = "cancelled"

    # Default payment policies
    DEFAULT_POLICIES = {
        "max_transaction_amount": {
            "type": "max_amount",
            "value": 10000.00,
            "currency": "USD",
            "description": "Maximum single transaction amount",
            "enabled": True,
        },
        "daily_spend_limit": {
            "type": "daily_limit",
            "value": 50000.00,
            "currency": "USD",
            "description": "Maximum daily spending limit",
            "enabled": True,
        },
        "allowed_categories": {
            "type": "category_whitelist",
            "value": ["food", "transport", "utilities", "entertainment", "shopping", "health", "education", "travel", "services"],
            "description": "Allowed transaction categories",
            "enabled": True,
        },
        "blocked_categories": {
            "type": "category_blacklist",
            "value": ["gambling", "crypto_exchange", "weapons"],
            "description": "Blocked transaction categories",
            "enabled": True,
        },
        "velocity_limit": {
            "type": "velocity",
            "value": 10,
            "window_seconds": 3600,
            "description": "Maximum transactions per hour",
            "enabled": True,
        },
        "fraud_detection": {
            "type": "fraud_score",
            "threshold": 0.7,
            "description": "Fraud score threshold for auto-decline",
            "enabled": True,
        },
    }

    # Fraud detection indicators
    FRAUD_INDICATORS = {
        "unusual_amount": {
            "weight": 0.25,
            "description": "Transaction amount significantly above average",
        },
        "high_frequency": {
            "weight": 0.20,
            "description": "Unusual transaction frequency",
        },
        "new_merchant": {
            "weight": 0.15,
            "description": "First transaction with this merchant",
        },
        "odd_time": {
            "weight": 0.10,
            "description": "Transaction at unusual hours (2-5 AM)",
        },
        "cross_border": {
            "weight": 0.15,
            "description": "Cross-border transaction",
        },
        "mismatch_category": {
            "weight": 0.15,
            "description": "Amount doesn't match typical category range",
        },
    }

    def __init__(
        self,
        agent_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(
            agent_id=agent_id,
            name="PaymentAgent",
            description="Processes payments, evaluates policies, and manages transactions with fraud detection",
            config=config,
        )
        self.policies: Dict[str, Dict[str, Any]] = dict(self.DEFAULT_POLICIES)
        # Apply config overrides
        if config and "policies" in config:
            for key, value in config["policies"].items():
                if key in self.policies:
                    self.policies[key].update(value)
                else:
                    self.policies[key] = value

        self._transactions: Dict[str, Dict[str, Any]] = {}
        self._daily_spending: Dict[str, float] = {}  # {date_str: total_amount}
        self._merchant_history: Dict[str, List[str]] = {}  # {merchant: [txn_ids]}
        self._velocity_tracker: List[float] = []  # Transaction timestamps

    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a payment agent task.

        Args:
            task: Task dict with 'type' and relevant parameters.

        Returns:
            Task result.
        """
        task_type = task.get("type", "process_payment")

        if task_type == "process_payment":
            return await self.process_payment(
                amount=task.get("amount", 0),
                currency=task.get("currency", "USD"),
                category=task.get("category", ""),
                merchant=task.get("merchant", ""),
                user_id=task.get("user_id", ""),
                metadata=task.get("metadata", {}),
            )
        elif task_type == "evaluate_policy":
            return await self.evaluate_policy(
                transaction=task.get("transaction", {}),
                policy_name=task.get("policy_name"),
            )
        elif task_type == "manage_transactions":
            return await self.manage_transactions(
                action=task.get("action", "list"),
                transaction_id=task.get("transaction_id"),
                params=task.get("params", {}),
            )
        else:
            return {"success": False, "error": f"Unknown task type: {task_type}"}

    def get_capabilities(self) -> List[Dict[str, Any]]:
        """Return agent capabilities."""
        return [
            {
                "name": "process_payment",
                "description": "Process a payment transaction with validation and fraud detection",
                "parameters": {
                    "amount": {"type": "number", "required": True, "description": "Transaction amount"},
                    "currency": {"type": "string", "required": False, "default": "USD"},
                    "category": {"type": "string", "required": False},
                    "merchant": {"type": "string", "required": False},
                    "user_id": {"type": "string", "required": False},
                    "metadata": {"type": "object", "required": False},
                },
            },
            {
                "name": "evaluate_policy",
                "description": "Evaluate a transaction against payment policies",
                "parameters": {
                    "transaction": {"type": "object", "required": True},
                    "policy_name": {"type": "string", "required": False},
                },
            },
            {
                "name": "manage_transactions",
                "description": "Manage transactions (list, refund, cancel)",
                "parameters": {
                    "action": {"type": "string", "required": True, "enum": ["list", "refund", "cancel", "get"]},
                    "transaction_id": {"type": "string", "required": False},
                    "params": {"type": "object", "required": False},
                },
            },
        ]

    async def process_payment(
        self,
        amount: float,
        currency: str = "USD",
        category: str = "",
        merchant: str = "",
        user_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Process a payment transaction.

        Validates the transaction against all active policies, performs
        fraud detection, and either approves or declines the transaction.

        Args:
            amount: Transaction amount.
            currency: Currency code.
            category: Transaction category.
            merchant: Merchant name or ID.
            user_id: User identifier.
            metadata: Additional transaction metadata.

        Returns:
            Transaction result with status and details.
        """
        start_time = time.time()
        metadata = metadata or {}

        self.logger.info("Processing payment: amount=%.2f %s, category=%s, merchant=%s",
                        amount, currency, category, merchant)

        # Validate input
        if amount <= 0:
            return {"success": False, "error": "Transaction amount must be positive"}

        # Generate transaction ID
        txn_id = f"TXN-{uuid.uuid4().hex[:12].upper()}"
        now = time.time()

        # Create transaction record
        transaction = {
            "transaction_id": txn_id,
            "amount": amount,
            "currency": currency,
            "category": category,
            "merchant": merchant,
            "user_id": user_id,
            "status": self.STATUS_PENDING,
            "created_at": now,
            "updated_at": now,
            "metadata": metadata,
        }

        # Evaluate all policies
        policy_results = await self._evaluate_all_policies(transaction)
        policy_violations = [r for r in policy_results if not r.get("passed", True)]

        # Compute fraud score
        fraud_score = self._compute_fraud_score(transaction)
        transaction["fraud_score"] = fraud_score

        # Determine transaction status
        if policy_violations:
            # Check if any violation is a hard block
            hard_blocks = [v for v in policy_violations if v.get("severity") == "hard_block"]
            if hard_blocks:
                transaction["status"] = self.STATUS_DECLINED
                transaction["decline_reason"] = hard_blocks[0].get("reason", "Policy violation")
            else:
                # Soft violations - may still be approved with review
                transaction["status"] = self.STATUS_PENDING
                transaction["review_required"] = True
                transaction["violations"] = policy_violations
        elif fraud_score >= self.policies.get("fraud_detection", {}).get("threshold", 0.7):
            transaction["status"] = self.STATUS_DECLINED
            transaction["decline_reason"] = f"Fraud score ({fraud_score:.2f}) exceeds threshold"
        else:
            transaction["status"] = self.STATUS_APPROVED

        # Record the transaction
        self._transactions[txn_id] = transaction

        # Update tracking
        if transaction["status"] == self.STATUS_APPROVED:
            self._update_daily_spending(amount)
            self._update_merchant_history(merchant, txn_id)
            self._velocity_tracker.append(now)

        elapsed = time.time() - start_time

        return {
            "success": transaction["status"] in (self.STATUS_APPROVED, self.STATUS_PENDING),
            "transaction_id": txn_id,
            "status": transaction["status"],
            "amount": amount,
            "currency": currency,
            "fraud_score": fraud_score,
            "policy_results": policy_results,
            "violations": policy_violations,
            "review_required": transaction.get("review_required", False),
            "processing_time": round(elapsed, 3),
        }

    async def evaluate_policy(
        self,
        transaction: Dict[str, Any],
        policy_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Evaluate a transaction against payment policies.

        Args:
            transaction: Transaction details to evaluate.
            policy_name: Specific policy to evaluate (all if None).

        Returns:
            Policy evaluation result.
        """
        if policy_name:
            if policy_name not in self.policies:
                return {"success": False, "error": f"Unknown policy: {policy_name}"}
            policy = self.policies[policy_name]
            if not policy.get("enabled", True):
                return {"success": True, "policy": policy_name, "result": "disabled", "passed": True}
            result = self._evaluate_single_policy(transaction, policy_name, policy)
            return {"success": True, "policy": policy_name, "result": result}

        # Evaluate all policies
        results = await self._evaluate_all_policies(transaction)
        return {"success": True, "policies": results}

    async def manage_transactions(
        self,
        action: str = "list",
        transaction_id: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Manage transactions.

        Args:
            action: Action to perform (list, refund, cancel, get).
            transaction_id: Transaction ID for specific actions.
            params: Additional parameters.

        Returns:
            Action result.
        """
        params = params or {}

        if action == "list":
            filters = params.get("filters", {})
            transactions = self._filter_transactions(filters)
            return {
                "success": True,
                "transactions": transactions,
                "total": len(transactions),
            }

        elif action == "get":
            if not transaction_id or transaction_id not in self._transactions:
                return {"success": False, "error": "Transaction not found"}
            return {"success": True, "transaction": self._transactions[transaction_id]}

        elif action == "refund":
            if not transaction_id or transaction_id not in self._transactions:
                return {"success": False, "error": "Transaction not found"}

            txn = self._transactions[transaction_id]
            if txn["status"] not in (self.STATUS_APPROVED, self.STATUS_PENDING):
                return {"success": False, "error": f"Cannot refund transaction with status: {txn['status']}"}

            refund_amount = params.get("amount", txn["amount"])
            if refund_amount > txn["amount"]:
                return {"success": False, "error": "Refund amount exceeds transaction amount"}

            txn["status"] = self.STATUS_REFUNDED
            txn["refund_amount"] = refund_amount
            txn["refunded_at"] = time.time()
            txn["updated_at"] = time.time()

            return {
                "success": True,
                "transaction_id": transaction_id,
                "refund_amount": refund_amount,
                "status": txn["status"],
            }

        elif action == "cancel":
            if not transaction_id or transaction_id not in self._transactions:
                return {"success": False, "error": "Transaction not found"}

            txn = self._transactions[transaction_id]
            if txn["status"] not in (self.STATUS_PENDING,):
                return {"success": False, "error": f"Cannot cancel transaction with status: {txn['status']}"}

            txn["status"] = self.STATUS_CANCELLED
            txn["cancelled_at"] = time.time()
            txn["updated_at"] = time.time()

            return {
                "success": True,
                "transaction_id": transaction_id,
                "status": txn["status"],
            }

        else:
            return {"success": False, "error": f"Unknown action: {action}"}

    # -------------------------------------------------------------------
    # Policy Evaluation
    # -------------------------------------------------------------------

    async def _evaluate_all_policies(self, transaction: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Evaluate a transaction against all active policies."""
        results = []

        for policy_name, policy in self.policies.items():
            if not policy.get("enabled", True):
                continue
            result = self._evaluate_single_policy(transaction, policy_name, policy)
            results.append(result)

        return results

    def _evaluate_single_policy(
        self,
        transaction: Dict[str, Any],
        policy_name: str,
        policy: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Evaluate a transaction against a single policy."""
        policy_type = policy.get("type", "")
        amount = transaction.get("amount", 0)
        category = transaction.get("category", "")

        result = {
            "policy": policy_name,
            "type": policy_type,
            "passed": True,
            "severity": "soft",
        }

        if policy_type == "max_amount":
            max_val = policy.get("value", float("inf"))
            if amount > max_val:
                result["passed"] = False
                result["severity"] = "hard_block"
                result["reason"] = f"Amount {amount} exceeds maximum {max_val}"

        elif policy_type == "daily_limit":
            limit = policy.get("value", float("inf"))
            today_spent = self._get_today_spending()
            if today_spent + amount > limit:
                result["passed"] = False
                result["severity"] = "hard_block"
                result["reason"] = f"Daily spending would exceed limit ({today_spent:.2f} + {amount:.2f} > {limit})"

        elif policy_type == "category_whitelist":
            allowed = policy.get("value", [])
            if category and category not in allowed:
                result["passed"] = False
                result["severity"] = "hard_block"
                result["reason"] = f"Category '{category}' not in allowed list"

        elif policy_type == "category_blacklist":
            blocked = policy.get("value", [])
            if category and category in blocked:
                result["passed"] = False
                result["severity"] = "hard_block"
                result["reason"] = f"Category '{category}' is blocked"

        elif policy_type == "velocity":
            max_count = policy.get("value", 10)
            window = policy.get("window_seconds", 3600)
            now = time.time()
            recent_count = sum(1 for ts in self._velocity_tracker if now - ts < window)
            if recent_count >= max_count:
                result["passed"] = False
                result["severity"] = "soft"
                result["reason"] = f"Velocity limit reached ({recent_count}/{max_count} in {window}s window)"

        elif policy_type == "fraud_score":
            threshold = policy.get("threshold", 0.7)
            fraud_score = transaction.get("fraud_score", 0)
            if fraud_score >= threshold:
                result["passed"] = False
                result["severity"] = "hard_block"
                result["reason"] = f"Fraud score {fraud_score:.2f} exceeds threshold {threshold}"

        return result

    # -------------------------------------------------------------------
    # Fraud Detection
    # -------------------------------------------------------------------

    def _compute_fraud_score(self, transaction: Dict[str, Any]) -> float:
        """Compute a fraud score for a transaction.

        Returns:
            Fraud score between 0.0 (safe) and 1.0 (highly suspicious).
        """
        score = 0.0
        amount = transaction.get("amount", 0)
        merchant = transaction.get("merchant", "")
        now = time.time()

        # Check unusual amount
        avg_amount = self._get_average_transaction_amount()
        if avg_amount > 0 and amount > avg_amount * 3:
            score += self.FRAUD_INDICATORS["unusual_amount"]["weight"]

        # Check frequency
        recent_count = sum(1 for ts in self._velocity_tracker if now - ts < 3600)
        if recent_count > 5:
            score += self.FRAUD_INDICATORS["high_frequency"]["weight"]

        # Check new merchant
        if merchant and merchant not in self._merchant_history:
            score += self.FRAUD_INDICATORS["new_merchant"]["weight"]

        # Check time of day
        import datetime
        hour = datetime.datetime.now().hour
        if 2 <= hour <= 5:
            score += self.FRAUD_INDICATORS["odd_time"]["weight"]

        # Check cross-border (simplified - check if currency is not default)
        if transaction.get("currency", "USD") != "USD":
            score += self.FRAUD_INDICATORS["cross_border"]["weight"]

        # Check category-amount mismatch
        category = transaction.get("category", "")
        if category and amount > 1000 and category in ("food", "transport"):
            score += self.FRAUD_INDICATORS["mismatch_category"]["weight"]

        return min(1.0, round(score, 3))

    # -------------------------------------------------------------------
    # Tracking Helpers
    # -------------------------------------------------------------------

    def _update_daily_spending(self, amount: float) -> None:
        """Update daily spending tracker."""
        import datetime
        today = datetime.date.today().isoformat()
        self._daily_spending[today] = self._daily_spending.get(today, 0) + amount

    def _get_today_spending(self) -> float:
        """Get today's total spending."""
        import datetime
        today = datetime.date.today().isoformat()
        return self._daily_spending.get(today, 0)

    def _update_merchant_history(self, merchant: str, txn_id: str) -> None:
        """Update merchant transaction history."""
        if merchant not in self._merchant_history:
            self._merchant_history[merchant] = []
        self._merchant_history[merchant].append(txn_id)

    def _get_average_transaction_amount(self) -> float:
        """Get the average amount of approved transactions."""
        approved = [t for t in self._transactions.values() if t["status"] == self.STATUS_APPROVED]
        if not approved:
            return 0.0
        return sum(t["amount"] for t in approved) / len(approved)

    def _filter_transactions(self, filters: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Filter transactions by criteria."""
        transactions = list(self._transactions.values())

        status_filter = filters.get("status")
        if status_filter:
            transactions = [t for t in transactions if t["status"] == status_filter]

        category_filter = filters.get("category")
        if category_filter:
            transactions = [t for t in transactions if t.get("category") == category_filter]

        min_amount = filters.get("min_amount")
        if min_amount is not None:
            transactions = [t for t in transactions if t["amount"] >= min_amount]

        max_amount = filters.get("max_amount")
        if max_amount is not None:
            transactions = [t for t in transactions if t["amount"] <= max_amount]

        limit = filters.get("limit", 100)
        return transactions[:limit]

    def get_policy_summary(self) -> Dict[str, Any]:
        """Get summary of all active policies."""
        return {
            "total_policies": len(self.policies),
            "enabled_policies": sum(1 for p in self.policies.values() if p.get("enabled", True)),
            "policies": {
                name: {
                    "type": policy.get("type"),
                    "enabled": policy.get("enabled", True),
                    "description": policy.get("description", ""),
                }
                for name, policy in self.policies.items()
            },
        }

    def get_transaction_stats(self) -> Dict[str, Any]:
        """Get transaction statistics."""
        transactions = list(self._transactions.values())
        if not transactions:
            return {"total_transactions": 0}

        status_counts: Dict[str, int] = {}
        total_amount = 0.0

        for txn in transactions:
            status_counts[txn["status"]] = status_counts.get(txn["status"], 0) + 1
            if txn["status"] == self.STATUS_APPROVED:
                total_amount += txn["amount"]

        return {
            "total_transactions": len(transactions),
            "total_amount": round(total_amount, 2),
            "status_counts": status_counts,
            "average_amount": round(total_amount / max(status_counts.get(self.STATUS_APPROVED, 1), 1), 2),
            "unique_merchants": len(self._merchant_history),
        }
