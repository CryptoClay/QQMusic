"""Shared editorial music data, private annotations and per-account preferences."""

import sqlalchemy as sa
from alembic import op

revision = "d9a2f5b81c03"
down_revision = "c7e9a1b35d02"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "music_editorial",
        sa.Column("key", sa.String(256), primary_key=True),
        sa.Column("data_json", sa.JSON(), nullable=False),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "music_private",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("ref", sa.String(200), primary_key=True),
        sa.Column("data_json", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "music_preferences",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("data_json", sa.JSON(), nullable=False),
    )


def downgrade():
    for table in ("music_preferences", "music_private", "music_editorial"):
        op.drop_table(table)
