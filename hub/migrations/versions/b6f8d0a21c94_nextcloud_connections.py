"""Private Nextcloud connections owned by Hub users."""

import sqlalchemy as sa
from alembic import op

revision = "b6f8d0a21c94"
down_revision = "a3c8e5f17b92"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "nextcloud_connections",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("server_url", sa.String(2048), nullable=False),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("password_enc", sa.Text(), nullable=False),
        sa.Column("folder", sa.String(1024), nullable=False),
        sa.Column("revision", sa.String(36), nullable=False),
    )


def downgrade():
    op.drop_table("nextcloud_connections")
