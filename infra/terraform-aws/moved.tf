# create_vpc/create_db/create_alb switches added count to these resources;
# the moved blocks keep existing deployments' state addresses valid so a
# plan after upgrading shows no changes.

moved {
  from = aws_vpc.main
  to   = aws_vpc.main[0]
}
moved {
  from = aws_internet_gateway.main
  to   = aws_internet_gateway.main[0]
}
moved {
  from = aws_eip.nat
  to   = aws_eip.nat[0]
}
moved {
  from = aws_nat_gateway.main
  to   = aws_nat_gateway.main[0]
}
moved {
  from = aws_route_table.public
  to   = aws_route_table.public[0]
}
moved {
  from = aws_route_table.private
  to   = aws_route_table.private[0]
}
moved {
  from = aws_db_subnet_group.main
  to   = aws_db_subnet_group.main[0]
}
moved {
  from = aws_security_group.db
  to   = aws_security_group.db[0]
}
moved {
  from = random_password.db
  to   = random_password.db[0]
}
moved {
  from = aws_db_instance.main
  to   = aws_db_instance.main[0]
}
moved {
  from = aws_security_group.alb
  to   = aws_security_group.alb[0]
}
moved {
  from = aws_security_group_rule.worker_from_alb
  to   = aws_security_group_rule.worker_from_alb[0]
}
moved {
  from = aws_lb.api
  to   = aws_lb.api[0]
}
moved {
  from = aws_lb_target_group.api
  to   = aws_lb_target_group.api[0]
}
moved {
  from = aws_lb_listener.http
  to   = aws_lb_listener.http[0]
}
