"""Persistent user queue pause and full album release date."""
import sqlalchemy as sa
from alembic import op

revision = "f1d5a8e032bc"
down_revision = "e0b4c7d921af"
branch_labels = depends_on = None


def upgrade():
    op.create_table("download_controls",
                    sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
                    sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("albums", sa.Column("release_date", sa.Date(), nullable=True))


def downgrade():
    op.drop_column("albums", "release_date")
    op.drop_table("download_controls")
