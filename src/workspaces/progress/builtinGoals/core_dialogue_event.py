# core:dialogue_event — satisfy on matching Talk dialogue outcome (default finished).
PlayerDialogueEvent = java_type("mchhui.rpgtoolkit.feature.talk.PlayerDialogueEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:dialogue_event")
@config(
    field("outcome", "string", default="finished", hint="enum:choice|finished"),
    field("node", "string", default="", hint="dialogue_node"),
    field("choice", "string", default="", hint="dialogue_choice"),
)
@state(
    field("have", "int", default=0),
)
class DialogueEventGoal(BaseGoalPy):
    @subscribe(PlayerDialogueEvent)
    def on_dialogue(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if str(cfg.outcome) and str(cfg.outcome) != str(event.getOutcome()):
            return
        if cfg.node and str(cfg.node) != str(event.getNodeId()):
            return
        if cfg.choice and str(cfg.choice) != str(event.getChoiceId()):
            return
        st.have = 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= 1)
