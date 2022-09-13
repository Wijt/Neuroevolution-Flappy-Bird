class Bird {
    constructor(x, y) {
        this.pos = {x: x, y: y};
        this.radius = BIRD_R,

        this.live = true;
        this.score = 0;
        this.velocity = 0;
    }

    show(){
        push();
            noStroke();
            fill(color(BIRD_COLOR));
            ellipse(this.pos.x, this.pos.y, this.radius, this.radius);
        pop();
    }

    jump(){
        this.velocity = 0;
        this.velocity -= BIRD_JUMP_POWER;
    }

    update() {
        if(this.pos.y < height - GROUND_HEIGHT){
            this.pos.y += this.velocity;
            this.velocity += GRAVITY;
        }else{
            this.pos.y = height - GROUND_HEIGHT;
        }
    }

}