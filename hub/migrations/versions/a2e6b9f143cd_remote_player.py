"""Account-scoped ephemeral playback devices and one-shot commands."""

import sqlalchemy as sa
from alembic import op

revision = "a2e6b9f143cd"
down_revision = "f1d5a8e032bc"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "playback_devices",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("device", sa.String(100), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("state_json", sa.JSON(), nullable=False),
        sa.Column("seen_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "playback_commands",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device", sa.String(100), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("result", sa.String(200)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "request_id", name="uq_playback_command_request"),
    )
    op.create_index("ix_playback_commands_target", "playback_commands", ["user_id", "device", "status", "id"])


def downgrade():
    op.drop_table("playback_commands")
    op.drop_table("playback_devices")
